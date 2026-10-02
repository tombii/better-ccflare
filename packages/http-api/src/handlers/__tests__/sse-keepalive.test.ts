import { describe, expect, it, spyOn } from "bun:test";
import { alertEvents, requestEvents } from "@better-ccflare/core";
import { logBus } from "@better-ccflare/logger";
import { createAlertsStreamHandler } from "../alerts";
import { createLogsStreamHandler } from "../logs";
import { createRequestsStreamHandler } from "../requests-stream";
import { startSseKeepalive } from "../sse-keepalive";

const INTERVAL = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cases = [
	{
		name: "requests",
		create: (ms: number) => createRequestsStreamHandler(ms),
		listeners: () => requestEvents.listenerCount("event"),
	},
	{
		name: "logs",
		create: (ms: number) => createLogsStreamHandler(ms),
		listeners: () => logBus.listenerCount("log"),
	},
	{
		name: "alerts",
		create: (ms: number) => createAlertsStreamHandler(ms),
		listeners: () => alertEvents.listenerCount("event"),
	},
];

async function readUntilPing(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<boolean> {
	const decoder = new TextDecoder();
	for (let i = 0; i < 10; i++) {
		const { value, done } = await reader.read();
		if (done) return false;
		if (decoder.decode(value) === ": ping\n\n") return true;
	}
	return false;
}

describe("startSseKeepalive", () => {
	it("stops itself and calls onFail when enqueue throws", async () => {
		let failed = 0;
		const controller = {
			enqueue: () => {
				throw new Error("closed");
			},
		} as unknown as ReadableStreamDefaultController<Uint8Array>;
		const stop = startSseKeepalive(controller, 5, () => failed++);
		await sleep(30);
		expect(failed).toBe(1);
		stop();
	});
});

for (const c of cases) {
	describe(`${c.name} stream keepalive`, () => {
		it("emits a ping comment while idle", async () => {
			const controller = new AbortController();
			const res = c.create(INTERVAL)(
				new Request("http://x/stream", { signal: controller.signal }),
			);
			const reader =
				res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
			expect(await readUntilPing(reader)).toBe(true);
			await reader.cancel();
		});

		it("clears the timer and listener on cancel", async () => {
			const before = c.listeners();
			const clearSpy = spyOn(globalThis, "clearInterval");
			const res = c.create(INTERVAL)(new Request("http://x/stream"));
			const reader =
				res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
			await reader.read();
			expect(c.listeners()).toBe(before + 1);
			clearSpy.mockClear();
			await reader.cancel();
			expect(clearSpy).toHaveBeenCalledTimes(1);
			expect(c.listeners()).toBe(before);
			clearSpy.mockRestore();
		});

		it("clears the timer and listener on abort", async () => {
			const before = c.listeners();
			const clearSpy = spyOn(globalThis, "clearInterval");
			const abort = new AbortController();
			const res = c.create(INTERVAL)(
				new Request("http://x/stream", { signal: abort.signal }),
			);
			const reader =
				res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
			await reader.read();
			clearSpy.mockClear();
			abort.abort();
			expect(clearSpy).toHaveBeenCalledTimes(1);
			expect(c.listeners()).toBe(before);
			clearSpy.mockRestore();
			await reader.cancel().catch(() => {});
		});
	});
}
