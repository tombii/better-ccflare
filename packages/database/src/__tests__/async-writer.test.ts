/**
 * Tests for AsyncDbWriter:
 *  - Backward-compatible enqueue() path (metadata queue)
 *  - New enqueuePayload() path (payload queue with byte + count caps)
 *  - Drain loop budget (MAX_JOBS_PER_TICK, MAX_DRAIN_MS_PER_TICK)
 *  - Round-robin starvation prevention (METADATA_PER_PAYLOAD = 100)
 *  - Payload-bytes accounting on success AND error paths
 *  - canAcceptPayload() admission probe
 *  - Watchdog tolerance for slow jobs
 *  - dispose() flushing both queues
 *
 * The implementation is in packages/database/src/async-writer.ts. These tests
 * exercise it without a real database — the "job" is just a callback.
 *
 * IMPORTANT: AsyncDbWriter.dispose() waits for both queues to empty by calling
 * processQueue() in a loop. If any in-flight job never resolves, dispose() will
 * hang. Tests that need to keep the queue full to observe drop behaviour use a
 * "gate" pattern: jobs await a manually-controlled promise that the test
 * releases before dispose() runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AsyncDbWriter } from "../async-writer";

const ONE_MB = 1024 * 1024;
const TEN_MB = 10 * ONE_MB;
const ONE_HUNDRED_MB = 100 * ONE_MB;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Manually-controlled async gate — release() lets all awaiters proceed. */
function makeGate(): { wait: () => Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait: () => promise, release };
}

describe("AsyncDbWriter", () => {
	let writer: AsyncDbWriter | null = null;
	let releaseGate: (() => void) | null = null;

	afterEach(async () => {
		// Release any pending gate so dispose() can drain in-flight jobs.
		if (releaseGate) {
			releaseGate();
			releaseGate = null;
		}
		if (writer) {
			try {
				await writer.dispose();
			} catch {
				// ignore cleanup failures
			}
			writer = null;
		}
	});

	test("enqueue() backward-compatible runs job and drains queue", async () => {
		writer = new AsyncDbWriter();
		let counter = 0;
		writer.enqueue(() => {
			counter++;
		});

		// Drain interval = 100 ms; processQueue is also kicked synchronously
		// on enqueue, so this should be done almost immediately.
		await sleep(200);

		expect(counter).toBe(1);
		expect(writer.getHealth().queuedJobs).toBe(0);
	});

	test("metadata cap drops excess (METADATA_QUEUE_CAP = 2000)", async () => {
		writer = new AsyncDbWriter();

		// Use a gate-blocked first job so the drain loop can't make progress
		// and the queue stays full during the test.
		const gate = makeGate();
		releaseGate = gate.release;

		// First job blocks the drain.
		writer.enqueue(async () => {
			await gate.wait();
		});
		// Fill the rest with no-ops; they won't run because the first awaits forever.
		for (let i = 1; i < 2100; i++) {
			writer.enqueue(() => {});
		}

		const h = writer.getHealth();
		// Job #1 is dequeued by the synchronous processQueue kick (`running=true`)
		// before the cap check happens for subsequent enqueues, so the queue holds
		// jobs #2..#2000 (length 1999) and #2001..#2100 are dropped (99 drops),
		// OR job #1 is still in queue depending on event-loop scheduling.
		expect(h.metadataQueuedJobs).toBeLessThanOrEqual(2000);
		expect(h.metadataDropped).toBeGreaterThanOrEqual(99);
	});

	test("enqueuePayload accepts up to byte cap, then rejects", async () => {
		writer = new AsyncDbWriter();

		// Gate-block all payload jobs so bytesPending doesn't decrement during the test.
		const gate = makeGate();
		releaseGate = gate.release;
		const blocked = async (): Promise<void> => {
			await gate.wait();
		};

		let acceptedBytes = 0;
		const results: boolean[] = [];
		// 10 calls of 10 MB each should fill the 100 MB cap exactly; the 11th rejects.
		for (let i = 0; i < 11; i++) {
			const ok = writer.enqueuePayload(`id-${i}`, TEN_MB, blocked);
			results.push(ok);
			if (ok) acceptedBytes += TEN_MB;
		}

		// First 10 accepted, 11th rejected.
		expect(results.slice(0, 10).every((r) => r === true)).toBe(true);
		expect(results[10]).toBe(false);

		const h = writer.getHealth();
		expect(h.payloadBytesPending).toBe(acceptedBytes);
		expect(acceptedBytes).toBe(ONE_HUNDRED_MB);
		expect(h.payloadDropped).toBeGreaterThanOrEqual(1);
	});

	test("enqueuePayload rejects on hard count cap (PAYLOAD_QUEUE_HARD_CAP = 1000)", async () => {
		writer = new AsyncDbWriter();

		// Gate-block payloads so the count stays at the cap.
		const gate = makeGate();
		releaseGate = gate.release;
		const blocked = async (): Promise<void> => {
			await gate.wait();
		};

		let _accepted = 0;
		let rejected = 0;
		for (let i = 0; i < 1100; i++) {
			const ok = writer.enqueuePayload(`id-${i}`, 1, blocked);
			if (ok) _accepted++;
			else rejected++;
		}

		// Job #1 may be dequeued (running) before the cap check kicks in, so
		// 1001 may be accepted and only 99 dropped. Either way: ≥99 dropped.
		expect(rejected).toBeGreaterThanOrEqual(99);
		const h = writer.getHealth();
		expect(h.payloadQueuedJobs).toBeLessThanOrEqual(1000);
		expect(h.payloadDropped).toBeGreaterThanOrEqual(99);
	});

	test("payloadBytesPending decrements on success", async () => {
		writer = new AsyncDbWriter();

		let ran = false;
		const ok = writer.enqueuePayload("id-success", 5_000_000, async () => {
			ran = true;
		});
		expect(ok).toBe(true);

		// Wait long enough for drain interval (100 ms) + job completion.
		await sleep(400);

		expect(ran).toBe(true);
		const h = writer.getHealth();
		expect(h.payloadBytesPending).toBe(0);
		expect(h.payloadQueuedJobs).toBe(0);
	});

	test("payloadBytesPending decrements on throw (finally-safety)", async () => {
		writer = new AsyncDbWriter();

		const ok = writer.enqueuePayload("id-throw", 5_000_000, async () => {
			throw new Error("boom");
		});
		expect(ok).toBe(true);

		await sleep(400);

		const h = writer.getHealth();
		expect(h.payloadBytesPending).toBe(0);
		expect(h.payloadQueuedJobs).toBe(0);

		// Subsequent enqueues must still work — counter is not permanently inflated.
		let ranAfter = false;
		const ok2 = writer.enqueuePayload("id-after", 1_000_000, async () => {
			ranAfter = true;
		});
		expect(ok2).toBe(true);

		await sleep(400);

		expect(ranAfter).toBe(true);
		expect(writer.getHealth().payloadBytesPending).toBe(0);
	});

	test("canAcceptPayload reflects current state", async () => {
		writer = new AsyncDbWriter();

		// Fresh writer: 50 MB fits easily under the 100 MB cap.
		expect(writer.canAcceptPayload(50 * ONE_MB)).toBe(true);

		// Enqueue 60 MB worth that won't drain (gate-blocked).
		const gate = makeGate();
		releaseGate = gate.release;
		const ok = writer.enqueuePayload("big", 60 * ONE_MB, async () => {
			await gate.wait();
		});
		expect(ok).toBe(true);

		// 60 MB pending + 50 MB candidate = 110 MB > 100 MB cap → false.
		expect(writer.canAcceptPayload(50 * ONE_MB)).toBe(false);
		// 30 MB still fits.
		expect(writer.canAcceptPayload(30 * ONE_MB)).toBe(true);
	});

	test("getHealth().oldestMetadataAgeMs reflects queue head age", async () => {
		writer = new AsyncDbWriter();

		// Block the drain by occupying the running slot with a gate-blocked
		// metadata job, then enqueue more so they remain queued and age.
		const gate = makeGate();
		releaseGate = gate.release;
		writer.enqueue(async () => {
			await gate.wait();
		});
		for (let i = 0; i < 9; i++) {
			writer.enqueue(() => {});
		}

		// Wait so the queue head ages.
		await sleep(150);

		const h = writer.getHealth();
		// The queue head (the 2nd enqueued job) should be ≥ ~150 ms old.
		expect(h.metadataQueuedJobs).toBeGreaterThan(0);
		expect(h.oldestMetadataAgeMs).toBeGreaterThanOrEqual(100);
	});

	test("round-robin prevents payload starvation", async () => {
		writer = new AsyncDbWriter();

		const order: Array<"metadata" | "payload"> = [];

		// Enqueue 250 metadata first…
		for (let i = 0; i < 250; i++) {
			writer.enqueue(() => {
				order.push("metadata");
			});
		}
		// …then 5 payloads.
		for (let i = 0; i < 5; i++) {
			const ok = writer.enqueuePayload(`p-${i}`, 1, async () => {
				order.push("payload");
			});
			expect(ok).toBe(true);
		}

		// Drain fully via dispose so we know everything completed.
		await writer.dispose();
		const localWriter = writer;
		writer = null;
		void localWriter;

		expect(order.length).toBe(255);

		// METADATA_PER_PAYLOAD = 100, so the first payload should appear around
		// index 100. If payloads were starved it would only appear after all 250
		// metadata jobs (index ≥ 250). The implementation currently reaches
		// index 250 — failure mode this test was written to catch.
		const firstPayloadIdx = order.indexOf("payload");
		expect(firstPayloadIdx).toBeGreaterThanOrEqual(0);
		expect(firstPayloadIdx).toBeLessThan(150);
	});

	test("MAX_JOBS_PER_TICK budget is honored (~50 jobs / 100 ms tick)", async () => {
		writer = new AsyncDbWriter();

		// 200 trivial sync jobs.
		let ran = 0;
		for (let i = 0; i < 200; i++) {
			writer.enqueue(() => {
				ran++;
			});
		}

		// Wait ~120 ms — just past one drain interval (100 ms). With the
		// MAX_JOBS_PER_TICK = 50 budget, we expect roughly one or two ticks'
		// worth (50–~150 depending on whether the synchronous kick + the first
		// interval fire have both happened).
		await sleep(120);

		// At least ~40 should have run (one tick budget) and not all 200.
		expect(ran).toBeGreaterThanOrEqual(40);
		expect(ran).toBeLessThan(200);
		expect(writer.getHealth().metadataQueuedJobs).toBeGreaterThan(0);
	});

	test("dispose drains both queues to completion", async () => {
		writer = new AsyncDbWriter();

		let counter = 0;
		for (let i = 0; i < 50; i++) {
			writer.enqueue(() => {
				counter++;
			});
		}
		for (let i = 0; i < 20; i++) {
			const ok = writer.enqueuePayload(`p-${i}`, 1000, async () => {
				counter++;
			});
			expect(ok).toBe(true);
		}

		await writer.dispose();
		const localWriter = writer;
		writer = null;

		expect(counter).toBe(70);
		const h = localWriter.getHealth();
		expect(h.metadataQueuedJobs).toBe(0);
		expect(h.payloadQueuedJobs).toBe(0);
		expect(h.payloadBytesPending).toBe(0);
	});

	test("watchdog does not crash on slow job (>1 s slow-warn threshold)", async () => {
		writer = new AsyncDbWriter();

		let ran = false;
		const ok = writer.enqueuePayload("slow", 1000, async () => {
			await sleep(1200);
			ran = true;
		});
		expect(ok).toBe(true);

		// Slow job runs for 1.2 s; allow drain interval + buffer.
		await sleep(1600);

		expect(ran).toBe(true);
		const h = writer.getHealth();
		expect(h.payloadBytesPending).toBe(0);
		expect(h.payloadQueuedJobs).toBe(0);
	});
});
