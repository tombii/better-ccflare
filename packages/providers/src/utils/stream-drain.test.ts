import { describe, expect, it } from "bun:test";
import { drainReaderWithDeadline } from "./stream-drain";

function makeReader(chunks: (Uint8Array | Error)[]): {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	releasedAt: () => number | null;
} {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				if (chunk instanceof Error) {
					controller.error(chunk);
					return;
				}
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
	const reader = stream.getReader();
	let releasedAt: number | null = null;
	const originalReleaseLock = reader.releaseLock.bind(reader);
	reader.releaseLock = () => {
		releasedAt = performance.now();
		originalReleaseLock();
	};
	return { reader, releasedAt: () => releasedAt };
}

function makeHangingReader(): {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	releasedAt: () => number | null;
} {
	const stream = new ReadableStream<Uint8Array>({
		start() {
			// Never enqueue or close — reads on this reader hang forever.
		},
	});
	const reader = stream.getReader();
	let releasedAt: number | null = null;
	const originalReleaseLock = reader.releaseLock.bind(reader);
	reader.releaseLock = () => {
		releasedAt = performance.now();
		originalReleaseLock();
	};
	return { reader, releasedAt: () => releasedAt };
}

describe("drainReaderWithDeadline", () => {
	it("drains all chunks to done and releases the lock", async () => {
		const { reader, releasedAt } = makeReader([
			Uint8Array.from([1, 2, 3]),
			Uint8Array.from([4, 5]),
		]);

		await drainReaderWithDeadline(reader, { deadlineMs: 1000 });

		expect(releasedAt()).not.toBeNull();
	});

	it("aborts drainAbort and releases the lock when the deadline expires mid-read", async () => {
		const { reader, releasedAt } = makeHangingReader();
		const drainAbort = new AbortController();

		await drainReaderWithDeadline(reader, {
			deadlineMs: 20,
			drainAbort,
		});

		expect(drainAbort.signal.aborted).toBe(true);
		expect(releasedAt()).not.toBeNull();
	});

	it("does not throw on deadline expiry when drainAbort is omitted", async () => {
		const { reader, releasedAt } = makeHangingReader();

		await drainReaderWithDeadline(reader, { deadlineMs: 20 });

		expect(releasedAt()).not.toBeNull();
	});

	it("races beforeDrain against the deadline and proceeds to the read loop once it settles", async () => {
		const { reader, releasedAt } = makeReader([Uint8Array.from([9])]);
		let beforeDrainRan = false;

		await drainReaderWithDeadline(reader, {
			deadlineMs: 1000,
			beforeDrain: async () => {
				beforeDrainRan = true;
				await Bun.sleep(5);
			},
		});

		expect(beforeDrainRan).toBe(true);
		expect(releasedAt()).not.toBeNull();
	});

	it("aborts and returns without touching the reader when beforeDrain outlasts the deadline", async () => {
		const { reader, releasedAt } = makeHangingReader();
		const drainAbort = new AbortController();
		let beforeDrainStarted = false;

		await drainReaderWithDeadline(reader, {
			deadlineMs: 15,
			drainAbort,
			beforeDrain: async () => {
				beforeDrainStarted = true;
				await new Promise(() => {
					// Never resolves — deadline must win the race.
				});
			},
		});

		expect(beforeDrainStarted).toBe(true);
		expect(drainAbort.signal.aborted).toBe(true);
		expect(releasedAt()).not.toBeNull();
	});

	it("propagates a read error when swallowErrors is false (default)", async () => {
		const { reader } = makeReader([new Error("boom")]);

		await expect(
			drainReaderWithDeadline(reader, { deadlineMs: 1000 }),
		).rejects.toThrow("boom");
	});

	it("swallows a read error when swallowErrors is true", async () => {
		const { reader, releasedAt } = makeReader([new Error("boom")]);

		await expect(
			drainReaderWithDeadline(reader, {
				deadlineMs: 1000,
				swallowErrors: true,
			}),
		).resolves.toBeUndefined();
		expect(releasedAt()).not.toBeNull();
	});

	it("releases the lock even when swallowErrors is false and the error propagates", async () => {
		const { reader, releasedAt } = makeReader([new Error("boom")]);

		await expect(
			drainReaderWithDeadline(reader, { deadlineMs: 1000 }),
		).rejects.toThrow();
		expect(releasedAt()).not.toBeNull();
	});
});
