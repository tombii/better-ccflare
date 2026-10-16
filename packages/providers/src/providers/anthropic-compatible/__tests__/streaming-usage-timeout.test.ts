/**
 * Regression tests for the streaming usage extractor's read timeout
 * (`BaseAnthropicCompatibleProvider.extractStreamingUsage`).
 *
 * The extractor must survive streams that stay open for minutes: an
 * Anthropic-compatible upstream only sends `message_delta` — the frame that
 * carries the final `output_tokens` — at the very END of the stream, and
 * agentic traffic regularly runs 90-180s. The original implementation applied
 * an ABSOLUTE 60s wall-clock budget to the whole read loop, so any healthy
 * stream that outlived it silently lost its usage data with
 * "Stream read timeout while extracting usage info".
 *
 * The budget is now an IDLE timeout (it only fires when no bytes arrive for
 * the configured window), driven by CCFLARE_STREAM_READ_TIMEOUT_MS.
 *
 * Timings here are milliseconds rather than minutes: the idle window comes
 * from the env override, and the compiled-in budget the OLD implementation
 * used as an absolute deadline is shrunk in the regression test so the
 * production failure (a 91s stream against a 60s budget) is reproducible
 * without a 60s wait.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getStreamReadTimeoutMs, TIME_CONSTANTS } from "@better-ccflare/core";
import { AnthropicCompatibleProvider } from "../provider";

const ENV_KEY = "CCFLARE_STREAM_READ_TIMEOUT_MS";

/**
 * TIME_CONSTANTS is declared `as const`, so the property is readonly to
 * TypeScript only — the object is a plain mutable module singleton at runtime.
 * The regression test uses that to shrink the compiled-in budget the old
 * implementation treated as an absolute deadline.
 */
const mutableTimeConstants = TIME_CONSTANTS as unknown as Record<
	string,
	number
>;

const savedEnv = process.env[ENV_KEY];
const savedDefaultBudget = TIME_CONSTANTS.STREAM_READ_TIMEOUT_MS;

afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedEnv;
	mutableTimeConstants.STREAM_READ_TIMEOUT_MS = savedDefaultBudget;
});

const encoder = new TextEncoder();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(10);
	}
	return predicate();
}

interface Step {
	/** Milliseconds to wait before this step is produced — a real idle gap. */
	delayBeforeMs?: number;
	/** Raw SSE text to enqueue. */
	chunk?: string;
	/** Terminates the stream instead of enqueueing a chunk. */
	end?: true;
}

/**
 * Build a `Response` whose body yields each step in order, waiting out
 * `delayBeforeMs` before each one. `wasDrained()` flips once the source has
 * been pulled past its last step, which is how these tests observe that the
 * extractor's `finally` drain actually consumed the rest of the body.
 *
 * `stepsConsumed()` is the stronger of the two signals. `wasDrained()` alone
 * cannot tell "the drain consumed the body" apart from "one trailing chunk
 * resolved the read that was already pending when the idle timer won, after
 * which the source advanced to its terminator unaided" — in the latter case
 * it still flips with the drain removed entirely. Counting the steps actually
 * pulled does distinguish them: a source with several trailing chunks only
 * reaches its end if something keeps reading it.
 */
function sseResponse(steps: Step[]): {
	response: Response;
	wasDrained: () => boolean;
	stepsConsumed: () => number;
} {
	let index = 0;
	let drained = false;
	let consumed = 0;

	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const step = steps[index++];
			if (!step) {
				drained = true;
				controller.close();
				return;
			}
			consumed++;
			if (step.delayBeforeMs) await sleep(step.delayBeforeMs);
			if (step.end) {
				drained = true;
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(step.chunk ?? ""));
		},
	});

	return {
		response: new Response(body, {
			headers: { "content-type": "text/event-stream" },
		}),
		wasDrained: () => drained,
		stepsConsumed: () => consumed,
	};
}

function messageStartChunk(inputTokens: number): string {
	return `event: message_start\ndata: ${JSON.stringify({
		type: "message_start",
		message: {
			model: "claude-sonnet-4-5",
			usage: {
				input_tokens: inputTokens,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		},
	})}\n\n`;
}

function messageDeltaChunk(outputTokens: number): string {
	return `event: message_delta\ndata: ${JSON.stringify({
		type: "message_delta",
		usage: { output_tokens: outputTokens },
	})}\n\n`;
}

const CONTENT_CHUNK = "event: content_block_delta\ndata: {}\n\n";

describe("streaming usage extraction read timeout", () => {
	// Regression for the core bug: the OLD implementation threw
	// "Stream read timeout while extracting usage info" once the TOTAL elapsed
	// wall clock passed the budget, discarding usage for a stream that was
	// perfectly healthy (bytes still arriving). With the budget as an idle
	// timeout, only the gap between chunks matters.
	test("extracts usage from a stream that outlives the old absolute wall-clock budget", async () => {
		// Idle window: 250ms. Every inter-chunk gap below is 40ms — well inside
		// the window — but the stream as a WHOLE runs well past it. That total
		// is load-bearing: if it stayed under the window, a future change that
		// used `getStreamReadTimeoutMs()` as a whole-stream deadline would
		// still pass this test, so it would no longer pin the idle semantics
		// this PR introduces.
		process.env[ENV_KEY] = "250";
		// The absolute deadline the old implementation applied to the whole loop.
		mutableTimeConstants.STREAM_READ_TIMEOUT_MS = 100;

		// 12 * 40ms = 480ms of content, comfortably past the 250ms idle window.
		const CONTENT_CHUNKS = 12;
		const { response } = sseResponse([
			{ chunk: messageStartChunk(1000) },
			...Array.from({ length: CONTENT_CHUNKS }, () => ({
				delayBeforeMs: 40,
				chunk: CONTENT_CHUNK,
			})),
			{ delayBeforeMs: 40, chunk: messageDeltaChunk(26_366) },
			{ end: true },
		]);

		const provider = new AnthropicCompatibleProvider();
		const started = Date.now();
		const usage = await provider.extractUsageInfo(response);
		const elapsed = Date.now() - started;

		// The stream ran longer in TOTAL than the configured idle window while
		// never going silent, so an idle timeout must let it finish. A
		// whole-stream deadline — whether the old 100ms constant or the 250ms
		// idle value itself — would have discarded the usage asserted below.
		expect(elapsed).toBeGreaterThan(250);
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(1000);
		expect(usage?.outputTokens).toBe(26_366);
		expect(usage?.completionTokens).toBe(26_366);
	});

	// An idle window that expires must still resolve — null, not a hang and not
	// a throw (the caller's `catch { return null }` treats both identically).
	test("returns null promptly when the stream goes silent past the idle window, and still drains the body", async () => {
		process.env[ENV_KEY] = "50";

		// Several trailing chunks, deliberately not one. With a single late
		// chunk the read that was already pending when the idle timer won
		// would resolve on it, and the source would then advance to its
		// terminator unaided — flipping `wasDrained()` even with the drain
		// removed. Enough trailing chunks that only a reader actually
		// consuming the body reaches the end.
		const LATE_CHUNKS = 5;
		const steps: Step[] = [
			{ chunk: messageStartChunk(1000) },
			// Arrives long after the idle window has already expired...
			{ delayBeforeMs: 200, chunk: CONTENT_CHUNK },
			// ...the rest are only ever read by the cleanup drain.
			...Array.from({ length: LATE_CHUNKS - 1 }, () => ({
				delayBeforeMs: 10,
				chunk: CONTENT_CHUNK,
			})),
			{ end: true },
		];
		const { response, wasDrained, stepsConsumed } = sseResponse(steps);

		const provider = new AnthropicCompatibleProvider();
		const started = Date.now();
		const usage = await provider.extractUsageInfo(response);
		const elapsed = Date.now() - started;

		expect(usage).toBeNull();
		// Resolved on the idle timer, not on the late chunk (t=200ms).
		expect(elapsed).toBeLessThan(150);
		// The `finally` drain is load-bearing for memory (Bun leaks the native
		// body buffer otherwise), so it must consume the WHOLE remaining body —
		// every trailing chunk and the terminator, not merely the one chunk
		// that happened to settle the already-pending read.
		expect(await waitFor(() => wasDrained())).toBe(true);
		expect(stepsConsumed()).toBe(steps.length);
	});

	test("extracts message_start input_tokens and message_delta output_tokens from a normal stream", async () => {
		delete process.env[ENV_KEY];

		const { response } = sseResponse([
			{ chunk: messageStartChunk(1000) },
			{ delayBeforeMs: 5, chunk: CONTENT_CHUNK },
			{ delayBeforeMs: 5, chunk: messageDeltaChunk(26_366) },
			{ end: true },
		]);

		const provider = new AnthropicCompatibleProvider();
		const usage = await provider.extractUsageInfo(response);

		expect(usage?.inputTokens).toBe(1000);
		expect(usage?.outputTokens).toBe(26_366);
		expect(usage?.promptTokens).toBe(1000);
		expect(usage?.completionTokens).toBe(26_366);
		expect(usage?.totalTokens).toBe(27_366);
	});
});

describe("getStreamReadTimeoutMs", () => {
	test("defaults to a 5 minute idle window", () => {
		// Pinned deliberately: a large prompt can take minutes to prefill before
		// the first output token, so the window must tolerate a long silent
		// prefill. It only bounds a DEAD stream, not a slow one.
		expect(TIME_CONSTANTS.STREAM_READ_TIMEOUT_MS).toBe(300_000);
		delete process.env[ENV_KEY];
		expect(getStreamReadTimeoutMs()).toBe(300_000);
	});

	test("falls back to the default when unset, unparseable or non-positive", () => {
		for (const raw of ["", "abc", "0", "-1", "NaN", "Infinity"]) {
			process.env[ENV_KEY] = raw;
			expect(getStreamReadTimeoutMs()).toBe(
				TIME_CONSTANTS.STREAM_READ_TIMEOUT_MS,
			);
		}
	});

	test("honors a valid positive override", () => {
		process.env[ENV_KEY] = "1234";
		expect(getStreamReadTimeoutMs()).toBe(1234);
	});

	test("drives the idle window end to end", async () => {
		const provider = new AnthropicCompatibleProvider();
		const stream = () =>
			sseResponse([
				{ chunk: messageStartChunk(10) },
				{ delayBeforeMs: 200, chunk: messageDeltaChunk(7) },
				{ end: true },
			]);

		// Window shorter than the gap: the late message_delta is never reached.
		process.env[ENV_KEY] = "40";
		expect(await provider.extractUsageInfo(stream().response)).toBeNull();

		// Same stream, window longer than the gap: usage comes through.
		process.env[ENV_KEY] = "2000";
		const usage = await provider.extractUsageInfo(stream().response);
		expect(usage?.outputTokens).toBe(7);
	});
});
