import { describe, expect, it } from "bun:test";
import { combineChunks, teeStream } from "./stream-tee";

/**
 * Builds a test "upstream" ReadableStream backed by a fixed list of chunks,
 * tracking how many chunks were produced (read by pull) and whether the
 * underlying source's cancel() was invoked.
 */
function makeTrackedUpstream(chunks: Uint8Array[]) {
	let pullCount = 0;
	let cancelCalled = false;
	let exhausted = false;
	let index = 0;

	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pullCount++;
			if (index >= chunks.length) {
				exhausted = true;
				controller.close();
				return;
			}
			controller.enqueue(chunks[index]);
			index++;
			if (index >= chunks.length) {
				// Not closed yet — closes on the *next* pull, matching real
				// fetch-body streams where `done` is observed on a
				// subsequent read() rather than bundled with the last chunk.
			}
		},
		cancel() {
			cancelCalled = true;
		},
	});

	return {
		stream,
		getPullCount: () => pullCount,
		wasCancelCalled: () => cancelCalled,
		wasExhausted: () => exhausted,
	};
}

function textChunk(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

async function readAll(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> {
	const reader = stream.getReader();
	const out: Uint8Array[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) out.push(value);
	}
	return out;
}

describe("teeStream", () => {
	it("passes chunks through to the consumer unmodified", async () => {
		const chunks = [textChunk("hello "), textChunk("world")];
		const { stream } = makeTrackedUpstream(chunks);

		const out = teeStream(stream);
		const received = await readAll(out);

		expect(received.length).toBe(2);
		expect(new TextDecoder().decode(combineChunks(received))).toBe(
			"hello world",
		);
	});

	it("fires onChunk for each chunk and onClose with the buffered chunks", async () => {
		const chunks = [textChunk("a"), textChunk("b"), textChunk("c")];
		const { stream } = makeTrackedUpstream(chunks);

		const seen: Uint8Array[] = [];
		let closedWith: Uint8Array[] | undefined;

		const out = teeStream(stream, {
			onChunk: (chunk) => seen.push(chunk),
			onClose: (buffered) => {
				closedWith = buffered;
			},
		});

		await readAll(out);

		expect(seen.length).toBe(3);
		expect(closedWith).toBeDefined();
		expect(closedWith?.length).toBe(3);
		expect(new TextDecoder().decode(combineChunks(closedWith ?? []))).toBe(
			"abc",
		);
	});

	it("respects maxBytes when buffering, while still passing all bytes through", async () => {
		const chunks = [textChunk("12345"), textChunk("67890"), textChunk("abcde")];
		const { stream } = makeTrackedUpstream(chunks);

		let closedWith: Uint8Array[] | undefined;
		const out = teeStream(stream, {
			maxBytes: 7,
			onClose: (buffered) => {
				closedWith = buffered;
			},
		});

		const received = await readAll(out);

		// All bytes still delivered to the consumer despite the buffer cap.
		expect(new TextDecoder().decode(combineChunks(received))).toBe(
			"1234567890abcde",
		);

		// Buffered analytics copy is capped at maxBytes.
		const bufferedTotal = (closedWith ?? []).reduce(
			(sum, c) => sum + c.length,
			0,
		);
		expect(bufferedTotal).toBe(7);
	});

	it("drains the upstream reader to completion on cancel instead of calling reader.cancel()", async () => {
		const chunks = [
			textChunk("chunk1"),
			textChunk("chunk2"),
			textChunk("chunk3"),
			textChunk("chunk4"),
		];
		const tracked = makeTrackedUpstream(chunks);

		const out = teeStream(tracked.stream);

		// Simulate what Bun does on client disconnect: cancel the outer
		// stream before it has been read to completion.
		const reader = out.getReader();
		await reader.cancel("client disconnected");

		// Give the fire-and-forget drain a chance to run to completion.
		await new Promise((resolve) => setTimeout(resolve, 10));

		// The regression: the upstream source must have been read to
		// exhaustion (drained), not merely abandoned via cancel().
		expect(tracked.wasExhausted()).toBe(true);
		expect(tracked.getPullCount()).toBeGreaterThanOrEqual(chunks.length);

		// The fix must not call the upstream reader's cancel() — draining
		// alone must release the native buffer (Bun's cancel() is a no-op,
		// oven-sh/bun#35093).
		expect(tracked.wasCancelCalled()).toBe(false);
	});

	it("swallows drain errors instead of throwing during cancel teardown", async () => {
		const erroringStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("boom during drain"));
			},
		});

		const out = teeStream(erroringStream);
		const reader = out.getReader();

		// Must not reject / throw — cancel() during teardown should not
		// propagate drain failures.
		await expect(reader.cancel("client disconnected")).resolves.toBeUndefined();

		// Let any fire-and-forget drain promise settle without an
		// unhandled rejection surfacing.
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
});
