/**
 * Zai returns HTTP 200 with a text/event-stream body whose first chunk carries
 * error code 1305 ("service overloaded"). These cover the detector and the
 * stream-peeking helper built on it; the retry/fallback wiring around them
 * lives in proxy-operations.ts, which is not importable from tests (it pulls
 * in @better-ccflare/database).
 */
import { describe, expect, it } from "bun:test";
import {
	hasZai1305Error,
	peekSseForZai1305,
	SSE_PEEK_MAX_BYTES,
	SSE_PEEK_TIMEOUT_MS,
} from "../zai-1305";

describe("hasZai1305Error", () => {
	it("detects the overload error in a first SSE chunk", () => {
		const chunk =
			'data: {"error":{"code":1305,"message":"The service is overloaded, please try again later"}}\n\n';
		expect(hasZai1305Error(chunk)).toBe(true);
	});

	it("ignores a normal stream opener", () => {
		const chunk =
			'data: {"id":"chatcmpl-1305","choices":[{"delta":{"content":"hi"}}]}\n\n';
		expect(hasZai1305Error(chunk)).toBe(false);
	});

	it("ignores an overload error that is not 1305", () => {
		const chunk =
			'data: {"error":{"code":1302,"message":"The service is overloaded"}}\n\n';
		expect(hasZai1305Error(chunk)).toBe(false);
	});

	it("is false for an empty chunk", () => {
		expect(hasZai1305Error("")).toBe(false);
	});

	it("ignores model output that merely mentions both words", () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":"Error 1305 means the service is overloaded in some contexts."}}]}\n\n';
		expect(hasZai1305Error(chunk)).toBe(false);
	});

	it("ignores 1305 and overloaded appearing outside an error object", () => {
		const chunk =
			'data: {"choices":[{"delta":{"content":"See error code 1305, service overloaded"}}]}\n\n';
		expect(hasZai1305Error(chunk)).toBe(false);
	});
});

/** Builds a Response whose body streams the given chunks with no delay. */
function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Builds a Response whose body drips chunks with a delay between each. */
function slowSseResponse(chunks: string[], delayMs: number): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			controller.enqueue(encoder.encode(chunks[i]));
			i++;
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("peekSseForZai1305", () => {
	it("matches a 1305 error in a single chunk", async () => {
		const response = sseResponse([
			'data: {"error":{"code":1305,"message":"overloaded"}}\n\n',
		]);
		expect(await peekSseForZai1305(response)).toBe(true);
	});

	it("matches a 1305 error split across chunk boundaries", async () => {
		const full =
			'data: {"error":{"code":1305,"message":"The service is overloaded"}}\n\n';
		const mid = Math.floor(full.length / 2);
		const response = sseResponse([full.slice(0, mid), full.slice(mid)]);
		expect(await peekSseForZai1305(response)).toBe(true);
	});

	it("returns false for a normal multi-chunk stream", async () => {
		const response = sseResponse([
			'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\n',
			'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" there"}}]}\n\n',
		]);
		expect(await peekSseForZai1305(response)).toBe(false);
	});

	it("leaves the original response body untouched (clone-based peek)", async () => {
		const chunk = 'data: {"error":{"code":1305,"message":"overloaded"}}\n\n';
		const response = sseResponse([chunk]);
		await peekSseForZai1305(response);
		const text = await response.text();
		expect(text).toBe(chunk);
	});

	it("returns false and does not hang when the stream never produces a match within the timeout", async () => {
		const response = slowSseResponse(
			['data: {"id":"chatcmpl-1"}\n\n', 'data: {"id":"chatcmpl-2"}\n\n'],
			SSE_PEEK_TIMEOUT_MS + 200,
		);
		const start = Date.now();
		const result = await peekSseForZai1305(response);
		const elapsed = Date.now() - start;
		expect(result).toBe(false);
		// Bounded by the timeout, not by how long the slow stream actually takes.
		expect(elapsed).toBeLessThan(SSE_PEEK_TIMEOUT_MS + 200);
	});

	it("does not throw when the timeout races a pending read", async () => {
		const response = slowSseResponse(
			['data: {"id":"chatcmpl-1"}\n\n'],
			SSE_PEEK_TIMEOUT_MS + 500,
		);
		await expect(peekSseForZai1305(response)).resolves.toBe(false);
	});

	it("stops accumulating once the byte cap is reached without a match", async () => {
		const filler = "x".repeat(SSE_PEEK_MAX_BYTES);
		const response = sseResponse([filler, filler]);
		expect(await peekSseForZai1305(response)).toBe(false);
	});

	it("returns false when the response has no body", async () => {
		const response = new Response(null, { status: 200 });
		expect(await peekSseForZai1305(response)).toBe(false);
	});
});
