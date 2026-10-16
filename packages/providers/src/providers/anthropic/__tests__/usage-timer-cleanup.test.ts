import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { AnthropicProvider } from "../provider";

/**
 * Regression tests for timer cleanup in `AnthropicProvider.extractUsageInfo`.
 *
 * The streaming branch of `extractUsageInfo` races each `reader.read()`
 * against a per-read timeout. There are two independent races: the main read
 * loop, and the extra read used to capture the `data:` line after
 * `message_start`. When the read wins — the normal case, reads settle in
 * milliseconds — the timeout must be cleared, otherwise every extraction
 * leaks up to two live timers, and a pending timer keeps the event loop (and
 * therefore process exit) alive.
 *
 * These tests spy on `globalThis.setTimeout` / `clearTimeout` to record the
 * handles the call arms and clears, then assert they balance. Only handles
 * armed with the provider's own per-read delay (5000 ms) are considered, so
 * timers Bun's stream machinery might arm internally are ignored.
 */

const PROVIDER_READ_TIMEOUT_MS = 5000;

/** Captured before any spy is installed, so test-internal timers are invisible to the spies. */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

interface TimerRecord {
	handle: ReturnType<typeof setTimeout>;
	/** The delay originally requested by the caller, before any remap. */
	delayMs: number | undefined;
}

interface TimerSpy {
	armed: TimerRecord[];
	cleared: Set<ReturnType<typeof setTimeout>>;
	restore: () => void;
}

/**
 * Install recording spies over the global timer functions.
 *
 * `remapDelayMs`, when supplied, shrinks the requested delay of matching
 * calls so a "read never settles" test can reach the timeout path without
 * waiting 5 real seconds. The recorded `delayMs` is always the originally
 * requested value, so scoping by delay still works.
 */
function installTimerSpy(remapDelayMs?: {
	from: number;
	to: number;
}): TimerSpy {
	const armed: TimerRecord[] = [];
	const cleared = new Set<ReturnType<typeof setTimeout>>();

	const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: (...args: unknown[]) => void,
		delayMs?: number,
		...args: unknown[]
	) => {
		const effectiveDelay =
			remapDelayMs && delayMs === remapDelayMs.from ? remapDelayMs.to : delayMs;
		const handle = realSetTimeout(
			callback as never,
			effectiveDelay as never,
			...(args as never[]),
		);
		armed.push({ handle: handle as ReturnType<typeof setTimeout>, delayMs });
		return handle;
	}) as unknown as typeof setTimeout);

	const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
		((handle?: ReturnType<typeof setTimeout>) => {
			if (handle !== undefined) cleared.add(handle);
			return realClearTimeout(handle as never);
		}) as unknown as typeof clearTimeout,
	);

	return {
		armed,
		cleared,
		restore: () => {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
		},
	};
}

/** The handles the provider's own per-read races armed, in order. */
function providerTimers(spy: TimerSpy): TimerRecord[] {
	return spy.armed.filter(
		(record) => record.delayMs === PROVIDER_READ_TIMEOUT_MS,
	);
}

/** Asserts every handle armed with the provider's per-read delay was cleared. */
function expectAllProviderTimersCleared(spy: TimerSpy, minimumArmed: number) {
	const armed = providerTimers(spy);
	expect(armed.length).toBeGreaterThanOrEqual(minimumArmed);
	const uncleared = armed.filter((record) => !spy.cleared.has(record.handle));
	expect(uncleared).toHaveLength(0);
}

function sseResponse(body: string): Response {
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

const MESSAGE_START_EVENT = [
	"event: message_start",
	`data: ${JSON.stringify({
		type: "message_start",
		message: {
			model: "claude-3-haiku",
			usage: {
				input_tokens: 100,
				output_tokens: 5,
				cache_creation_input_tokens: 10,
				cache_read_input_tokens: 5,
			},
		},
	})}`,
	"",
	"event: content_block_start",
	'data: {"type":"content_block_start","index":0}',
	"",
].join("\n");

const NON_MESSAGE_START_EVENT =
	'event: content_block_start\ndata: {"type":"content_block_start"}\n\n';

let activeSpy: TimerSpy | undefined;

afterEach(() => {
	activeSpy?.restore();
	activeSpy = undefined;
});

describe("AnthropicProvider.extractUsageInfo — streaming read timer cleanup", () => {
	const provider = new AnthropicProvider();

	it("clears every read timer it arms when reads win the race", async () => {
		// Build the response before installing the spy so only the extraction
		// call's timers are recorded.
		const response = sseResponse(MESSAGE_START_EVENT);
		const spy = installTimerSpy();
		activeSpy = spy;

		const usage = await provider.extractUsageInfo(response);

		// Behaviour unchanged: usage extracted from message_start.
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(100);
		expect(usage?.cacheCreationInputTokens).toBe(10);
		expect(usage?.cacheReadInputTokens).toBe(5);

		// Both races arm a 5s timer; both must be cleared once the read wins.
		expectAllProviderTimersCleared(spy, 2);

		// Nothing the call armed at all was left behind.
		expect(spy.cleared.size).toBe(spy.armed.length);
	});

	it("clears the read timer on the timeout path and still returns null", async () => {
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		// Pull-driven source: `pull` is only invoked when a reader is waiting for
		// data, and it deliberately stalls, so the second read never settles.
		// `pullCalls` therefore counts read demand — including the detached
		// drain in `finally { void drainReader(reader) }`.
		let pullCalls = 0;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				c.enqueue(encoder.encode(NON_MESSAGE_START_EVENT));
			},
			pull() {
				pullCalls++;
				return new Promise<void>((resolve) => {
					realSetTimeout(resolve, 50);
				});
			},
		});

		const response = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});

		// The stalled read must lose to the 5s timeout; shrink it so the test is
		// fast. The timeout VALUE under test is unchanged.
		const spy = installTimerSpy({ from: PROVIDER_READ_TIMEOUT_MS, to: 25 });
		activeSpy = spy;

		const usage = await provider.extractUsageInfo(response);

		// Timeout path: the error propagates to the outer catch, which returns null.
		expect(usage).toBeNull();
		expectAllProviderTimersCleared(spy, 2);

		// The drain keeps reading after the timeout: the first read consumed the
		// queued chunk, and the drain's read re-triggers `pull`. Without the
		// drain only the (still pending) raced read would hold the source, so
		// `pull` would not be called again.
		const drainDeadline = Date.now() + 1000;
		while (pullCalls < 2 && Date.now() < drainDeadline) {
			await new Promise((resolve) => realSetTimeout(resolve, 10));
		}
		expect(pullCalls).toBeGreaterThanOrEqual(2);

		// Close so the stalled drain read and the pull loop can finish.
		controller?.close();
	});

	it("usage math from message_start is unchanged", async () => {
		const response = sseResponse(MESSAGE_START_EVENT);

		const usage = await provider.extractUsageInfo(response);

		expect(usage).not.toBeNull();
		expect(usage?.model).toBe("claude-3-haiku");
		expect(usage?.inputTokens).toBe(100);
		expect(usage?.cacheCreationInputTokens).toBe(10);
		expect(usage?.cacheReadInputTokens).toBe(5);
		expect(usage?.outputTokens).toBe(5);
		// promptTokens = input + cache_creation + cache_read = 100 + 10 + 5
		expect(usage?.promptTokens).toBe(115);
		expect(usage?.completionTokens).toBe(5);
		// totalTokens = promptTokens + completionTokens = 115 + 5
		expect(usage?.totalTokens).toBe(120);
	});
});
