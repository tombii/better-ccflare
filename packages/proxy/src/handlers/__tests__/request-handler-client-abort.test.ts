import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { makeProxyRequest } from "../request-handler";

/**
 * Client-disconnect propagation for the upstream fetch.
 *
 * Background: a client that goes away mid-stream (Claude Code's 300 s idle
 * watchdog, Ctrl-C, network drop) left the upstream connection running,
 * because makeProxyRequest overwrote any caller signal with its own
 * timeout-only controller — and that controller is unreachable once the
 * headers arrive (its timer is cleared in `finally`).
 *
 * These tests drive a real local upstream so the assertions measure actual
 * socket behaviour rather than a mock's promise. The upstream records how many
 * requests it saw and whether its response stream was cancelled.
 */

interface Upstream {
	url: string;
	requests: number;
	cancelled: string[];
	pulls: number;
	stop: () => void;
}

function startUpstream(opts: { chunkDelayMs?: number } = {}): Upstream {
	const state = {
		requests: 0,
		cancelled: [] as string[],
		pulls: 0,
	};
	const delay = opts.chunkDelayMs ?? 100;
	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch() {
			state.requests++;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						state.pulls++;
						await Bun.sleep(delay);
						controller.enqueue(
							new TextEncoder().encode(`: chunk ${state.pulls}\n\n`),
						);
					},
					cancel(reason) {
						state.cancelled.push(String(reason ?? "no-reason"));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1/messages`,
		get requests() {
			return state.requests;
		},
		get cancelled() {
			return state.cancelled;
		},
		get pulls() {
			return state.pulls;
		},
		stop: () => server.stop(true),
	};
}

/** Reads one chunk so we are provably past the header boundary. */
async function readOneChunk(response: Response): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("response had no body");
	await reader.read();
	reader.releaseLock();
}

describe("makeProxyRequest: client disconnect aborts the upstream fetch", () => {
	let upstream: Upstream;

	beforeAll(() => {
		upstream = startUpstream();
	});

	afterAll(() => {
		upstream.stop();
	});

	it("aborts the upstream when the caller signal fires AFTER the headers arrived", async () => {
		const controller = new AbortController();
		const response = await makeProxyRequest(
			upstream.url,
			"POST",
			new Headers({ "content-type": "application/json" }),
			undefined,
			false,
			controller.signal,
		);
		expect(response.status).toBe(200);

		await readOneChunk(response);
		const pullsAtAbort = upstream.pulls;
		const cancelledBefore = upstream.cancelled.length;

		controller.abort();
		await Bun.sleep(600);

		// The upstream must stop producing: at most the in-flight pull completes.
		expect(upstream.pulls).toBeLessThanOrEqual(pullsAtAbort + 1);
		expect(upstream.cancelled.length).toBeGreaterThan(cancelledBefore);
	});

	it("aborts the upstream when the signal is inherited from a Request target", async () => {
		const controller = new AbortController();
		// This mirrors the production shape: the proxy hands a Request object to
		// makeProxyRequest. A Request carries its own signal, which must not be
		// discarded.
		const target = new Request(upstream.url, {
			method: "POST",
			signal: controller.signal,
		});

		const response = await makeProxyRequest(target);
		expect(response.status).toBe(200);

		await readOneChunk(response);
		const pullsAtAbort = upstream.pulls;
		const cancelledBefore = upstream.cancelled.length;

		controller.abort();
		await Bun.sleep(600);

		expect(upstream.pulls).toBeLessThanOrEqual(pullsAtAbort + 1);
		expect(upstream.cancelled.length).toBeGreaterThan(cancelledBefore);
	});

	it("rejects without contacting the upstream when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const before = upstream.requests;

		await expect(
			makeProxyRequest(
				upstream.url,
				"POST",
				new Headers(),
				undefined,
				false,
				controller.signal,
			),
		).rejects.toThrow();

		expect(upstream.requests).toBe(before);
	});

	it("surfaces an AbortError (not a timeout error) when the client goes away", async () => {
		const controller = new AbortController();
		const response = await makeProxyRequest(
			upstream.url,
			"POST",
			new Headers(),
			undefined,
			false,
			controller.signal,
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no body");

		controller.abort();

		let caught: unknown;
		try {
			// Draining after the abort must fail, and it must fail as an abort.
			for (;;) {
				const { done } = await reader.read();
				if (done) break;
			}
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect((caught as Error).name).toBe("AbortError");
	});
});

describe("makeProxyRequest: existing contracts stay intact", () => {
	let upstream: Upstream;

	beforeAll(() => {
		upstream = startUpstream();
	});

	afterAll(() => {
		upstream.stop();
	});

	it("still performs the request when no signal is supplied", async () => {
		const response = await makeProxyRequest(
			upstream.url,
			"POST",
			new Headers({ "content-type": "application/json" }),
			undefined,
			false,
		);
		expect(response.status).toBe(200);
		expect(upstream.requests).toBeGreaterThan(0);
		await response.body?.cancel();
	});

	it("does not abort a healthy in-flight stream while the caller signal stays quiet", async () => {
		const controller = new AbortController();
		const response = await makeProxyRequest(
			upstream.url,
			"POST",
			new Headers(),
			undefined,
			false,
			controller.signal,
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no body");

		// Drain several chunks across a span that dwarfs a chunk delay. The
		// header timeout must already be disarmed at this point, so nothing may
		// tear the stream down.
		const decoder = new TextDecoder();
		let seen = 0;
		for (let i = 0; i < 4; i++) {
			const { value, done } = await reader.read();
			if (done) break;
			if (decoder.decode(value).includes("chunk")) seen++;
		}
		expect(seen).toBeGreaterThanOrEqual(3);
		expect(controller.signal.aborted).toBe(false);

		await reader.cancel();
	});

	it("keeps the caller signal usable as the abort source for the whole stream lifetime", async () => {
		// Guards the combination: a caller signal must remain effective after the
		// header-phase timeout has been cleared. If the implementation returned a
		// signal that is detached once headers land, this abort would be a no-op.
		const controller = new AbortController();
		const response = await makeProxyRequest(
			upstream.url,
			"POST",
			new Headers(),
			undefined,
			false,
			controller.signal,
		);
		await readOneChunk(response);
		await Bun.sleep(300); // well past the header boundary

		const cancelledBefore = upstream.cancelled.length;
		controller.abort();
		await Bun.sleep(600);

		expect(upstream.cancelled.length).toBeGreaterThan(cancelledBefore);
	});
});
