import { afterEach, describe, expect, test } from "bun:test";
import {
	acquireCachePacing,
	CACHE_PACING_MS_ENV,
	finishPacing,
	readCachePacingMs,
	resetCachePacing,
} from "../cache-pacing";

afterEach(() => {
	resetCachePacing();
	delete process.env[CACHE_PACING_MS_ENV];
});

function sseResponse(chunks: string[], delayMs = 0): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				if (delayMs > 0) {
					await new Promise((r) => setTimeout(r, delayMs));
				}
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("readCachePacingMs", () => {
	test("disabled by default, parses overrides, rejects nonsense", () => {
		expect(readCachePacingMs()).toBe(0);
		process.env[CACHE_PACING_MS_ENV] = "15000";
		expect(readCachePacingMs()).toBe(15_000);
		process.env[CACHE_PACING_MS_ENV] = "junk";
		expect(readCachePacingMs()).toBe(0);
	});
});

describe("acquireCachePacing", () => {
	test("returns null when disabled or session missing", async () => {
		expect(
			await acquireCachePacing({ sessionKey: "s1", model: "m" }),
		).toBeNull();
		process.env[CACHE_PACING_MS_ENV] = "1000";
		expect(
			await acquireCachePacing({ sessionKey: null, model: "m" }),
		).toBeNull();
	});

	test("first request leads immediately, follower waits for first body chunk", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s1", model: "m" });
		expect(leader).not.toBeNull();

		let followerReleased = false;
		const followerPromise = acquireCachePacing({
			sessionKey: "s1",
			model: "m",
		}).then((slot) => {
			followerReleased = true;
			return slot;
		});

		await new Promise((r) => setTimeout(r, 30));
		expect(followerReleased).toBe(false);

		// Leader's response starts streaming: first chunk releases the follower.
		const wrapped = finishPacing(leader, sseResponse(["event: a\n\n"], 10));
		await wrapped.text();

		const followerSlot = await followerPromise;
		expect(followerReleased).toBe(true);
		expect(followerSlot).toBeNull();
	});

	test("wrapped body passes through byte-identical", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s2", model: "m" });
		const wrapped = finishPacing(leader, sseResponse(["hello ", "world"], 1));
		expect(await wrapped.text()).toBe("hello world");
		expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
	});

	test("abandon releases followers immediately", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s3", model: "m" });
		const start = Date.now();
		const followerPromise = acquireCachePacing({
			sessionKey: "s3",
			model: "m",
		});
		leader?.abandon();
		await followerPromise;
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	test("non-ok leader response abandons instead of wrapping", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s4", model: "m" });
		const followerPromise = acquireCachePacing({
			sessionKey: "s4",
			model: "m",
		});
		const errorResponse = new Response("nope", { status: 503 });
		const finished = finishPacing(leader, errorResponse);
		expect(finished.status).toBe(503);
		await followerPromise; // resolves promptly because abandon fired
	});

	test("follower releases at the cap when the leader never streams", async () => {
		process.env[CACHE_PACING_MS_ENV] = "50";
		await acquireCachePacing({ sessionKey: "s5", model: "m" });
		const start = Date.now();
		await acquireCachePacing({ sessionKey: "s5", model: "m" });
		const held = Date.now() - start;
		expect(held).toBeGreaterThanOrEqual(40);
		expect(held).toBeLessThan(2_000);
	});

	test("different sessions and models do not block each other", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const start = Date.now();
		await acquireCachePacing({ sessionKey: "s6", model: "m1" });
		await acquireCachePacing({ sessionKey: "s6", model: "m2" });
		await acquireCachePacing({ sessionKey: "s7", model: "m1" });
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	test("stale leader is replaced instead of waited on", async () => {
		process.env[CACHE_PACING_MS_ENV] = "100";
		let clock = 1_000_000;
		const now = () => clock;
		const first = await acquireCachePacing({
			sessionKey: "s8",
			model: "m",
			now,
		});
		expect(first).not.toBeNull();
		// Advance beyond 2x the cap: the dead leader must not hold newcomers.
		clock += 500;
		const start = Date.now();
		const second = await acquireCachePacing({
			sessionKey: "s8",
			model: "m",
			now,
		});
		expect(second).not.toBeNull();
		expect(Date.now() - start).toBeLessThan(1_000);
	});
});
