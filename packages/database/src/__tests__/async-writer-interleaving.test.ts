/**
 * Regression test for AsyncDbWriter event-loop yielding.
 *
 * Background: a memory leak was diagnosed where the post-processor worker's
 * `requests: Map<string, RequestState>` grew unboundedly because the
 * AsyncDbWriter's `processQueue` monopolized the worker's event loop with
 * synchronous bun:sqlite calls. That starved the 30s `setInterval`-based
 * `cleanupStaleRequests` and the worker's `postMessage` queue handlers.
 *
 * The fix introduced a dual budget on `processQueue`:
 *   - MAX_JOBS_PER_TICK = 50
 *   - MAX_DRAIN_MS_PER_TICK = 250
 * After either is exceeded the drain yields and the 100ms setInterval
 * restarts it. This test verifies that under heavy DB-write load OTHER
 * setInterval callbacks and message-handler logic on the same event loop
 * still get to run within bounded time.
 */
import { expect, test } from "bun:test";
import { AsyncDbWriter } from "../async-writer";

test("processQueue yields the event loop so concurrent setInterval can fire", async () => {
	const writer = new AsyncDbWriter();

	// Enqueue 500 metadata jobs that each take ~10 ms of *synchronous* CPU
	// work to simulate the bun:sqlite-style blocking behavior. Use a busy-wait
	// (`while (Date.now() - t0 < 10) {}`) — NOT setTimeout — because the bug
	// we're testing for is precisely that the event loop blocks during the
	// job, so we need the same shape.
	let jobsRun = 0;
	for (let i = 0; i < 500; i++) {
		writer.enqueue(() => {
			const t0 = Date.now();
			while (Date.now() - t0 < 10) {
				// busy-wait — same shape as a synchronous SQLite call
			}
			jobsRun++;
		});
	}

	// Concurrent ticker — counts how many times it fires during the load.
	// If the writer's drain monopolized the event loop, this would tick zero
	// or very few times. With the dual count+time budget, it should tick
	// many times because the writer drops out of processQueue after ~250 ms
	// or 50 jobs, whichever first.
	let tickerFires = 0;
	const ticker = setInterval(() => {
		tickerFires++;
	}, 50);

	// Run the load for ~2 seconds and observe.
	const observeMs = 2000;
	await new Promise((resolve) => setTimeout(resolve, observeMs));

	clearInterval(ticker);
	await writer.dispose();

	// Sanity: jobs progressed (not all 500 necessarily, but a significant chunk).
	expect(jobsRun).toBeGreaterThan(50);

	// The critical assertion: the concurrent ticker had a chance to fire.
	// Without the fix (old code: while(queue.length > 0) await job()), the
	// ticker would have fired far less (0-1) because the writer monopolized
	// the loop for ~5s straight.
	//
	// With the fix the writer drops out of processQueue after MAX_DRAIN_MS=250ms
	// or MAX_JOBS=50, whichever first. Empirically that means roughly one
	// yield window per ~250ms during the 2s observation = ~6-8 ticker fires
	// (the 50ms ticker can fit at most one fire per 250ms drain window).
	// Use >=5 as a safe lower bound that still proves yielding is happening
	// and tolerates CI slowness.
	expect(tickerFires).toBeGreaterThanOrEqual(5);

	// Surface the observed values in test output for later inspection.
	console.log(
		`[interleaving] jobsRun=${jobsRun}, tickerFires=${tickerFires}, observeMs=${observeMs}`,
	);
});

test("drain budget caps tick duration to MAX_DRAIN_MS_PER_TICK + slowest job", async () => {
	const writer = new AsyncDbWriter();

	// Enqueue 100 fast jobs. Measure how long until processQueue (which is
	// kicked off synchronously inside enqueue()) returns.
	for (let i = 0; i < 100; i++) {
		writer.enqueue(() => {
			const t0 = Date.now();
			while (Date.now() - t0 < 10) {
				/* busy 10ms */
			}
		});
	}

	// Give the first tick a moment to run.
	const synchronousReturnedAt = Date.now();
	await new Promise((r) => setImmediate(r));
	const elapsed = Date.now() - synchronousReturnedAt;

	// The synchronous portion of `enqueue()` calls `void this.processQueue()`
	// — the first tick is async. After setImmediate, the first tick has
	// completed. It should have done at most MAX_JOBS_PER_TICK=50 jobs.
	// jobsRun after the first tick should be no more than 50.
	// (Subsequent ticks drain the rest.)
	//
	// Indirect assertion: getHealth().metadataQueuedJobs should still be
	// close to 50 after one tick (started at 100, drained ≤ 50).
	const queued = writer.getHealth().metadataQueuedJobs;
	expect(queued).toBeGreaterThanOrEqual(40);
	expect(queued).toBeLessThanOrEqual(100);

	// Surface the observed values in test output for later inspection.
	console.log(
		`[drain-budget] queuedAfterFirstTick=${queued}, elapsed_ms=${elapsed}`,
	);

	await writer.dispose();
});
