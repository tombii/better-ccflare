/**
 * Regression test for issue #382 — the teeStream and
 * createAnthropicTerminalRecoveryStream done/error paths must release the
 * upstream reader's lock once the wrapper stream completes normally. A reader
 * left locked keeps the source stream pinned (no other consumer can
 * getReader() it) and, in production, retains the fetch body's native
 * off-heap buffer.
 *
 * Runtime check: consume the readable side to `done` (no cancel), then
 * assert source.getReader() succeeds — it throws TypeError if the stream is
 * still locked to the wrapper's reader.
 *
 * Run: bun test packages/proxy/src/__tests__/stream-reader-lock-release-382.test.ts
 */
import { describe, expect, it } from "bun:test";
import { createAnthropicTerminalRecoveryStream } from "../anthropic-terminal-recovery";
import { teeStream } from "../stream-tee";

const encoder = new TextEncoder();

function immediateStream(
	chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function drainToDone(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	while (true) {
		const { done } = await reader.read();
		if (done) return;
	}
}

describe("issue #382 — reader lock release on normal completion", () => {
	it("teeStream releases the upstream reader lock after done", async () => {
		const source = immediateStream([
			encoder.encode("hello "),
			encoder.encode("world"),
		]);
		const teed = teeStream(source);
		await drainToDone(teed);
		expect(() => source.getReader()).not.toThrow();
	});

	it("terminal-recovery stream releases the upstream reader lock after done", async () => {
		const source = immediateStream([
			encoder.encode(
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}\n\n',
			),
			encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
		]);
		const wrapped = createAnthropicTerminalRecoveryStream(source);
		await drainToDone(wrapped);
		expect(() => source.getReader()).not.toThrow();
	});
});
