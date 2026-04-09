import { describe, expect, it } from "bun:test";
import { createSseRateLimitSniffer } from "../sse-rate-limit-sniffer";

const encode = (s: string) => new TextEncoder().encode(s);

describe("SseRateLimitSniffer", () => {
	it("detects a complete rate-limit error frame in a single chunk", () => {
		const sniffer = createSseRateLimitSniffer();
		const frame = encode(
			'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(true);
	});

	it("detects a rate-limit error frame split across multiple chunks", () => {
		const sniffer = createSseRateLimitSniffer();

		// Chunk 1: partial event + partial data (the marker is split)
		expect(
			sniffer.feed(encode('event: error\ndata: {"type":"error","error":{"type":"rate_lim')),
		).toBe(false);

		// Chunk 2: the rest of the marker
		expect(
			sniffer.feed(encode('it_error","message":"Rate limited"}}\n\n')),
		).toBe(true);
	});

	it("ignores overloaded_error frames", () => {
		const sniffer = createSseRateLimitSniffer();
		const frame = encode(
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(false);
	});

	it("ignores api_error frames", () => {
		const sniffer = createSseRateLimitSniffer();
		const frame = encode(
			'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Server error"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(false);
	});

	it("ignores regular content chunks", () => {
		const sniffer = createSseRateLimitSniffer();
		const chunks = [
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		for (const chunk of chunks) {
			expect(sniffer.feed(encode(chunk))).toBe(false);
		}
	});

	it("fires only once even if the buffer still matches on subsequent feeds", () => {
		const sniffer = createSseRateLimitSniffer();

		// First rate-limit frame fires
		expect(
			sniffer.feed(
				encode(
					'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"First"}}\n\n',
				),
			),
		).toBe(true);

		// Second rate-limit frame does NOT fire — one-shot semantics
		expect(
			sniffer.feed(
				encode(
					'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Second"}}\n\n',
				),
			),
		).toBe(false);
	});

	it("handles empty chunks gracefully", () => {
		const sniffer = createSseRateLimitSniffer();
		expect(sniffer.feed(encode(""))).toBe(false);
		expect(sniffer.feed(new Uint8Array(0))).toBe(false);
	});

	it("does not grow memory unboundedly for long non-matching streams", () => {
		const sniffer = createSseRateLimitSniffer();
		// Feed 200KB of content without a rate-limit marker
		const bigChunk = encode("a".repeat(1024));
		for (let i = 0; i < 200; i++) {
			expect(sniffer.feed(bigChunk)).toBe(false);
		}
		// Feed the marker — should still be detected even after the buffer
		// was trimmed many times
		expect(
			sniffer.feed(
				encode(
					'data: {"type":"error","error":{"type":"rate_limit_error","message":"Late"}}\n\n',
				),
			),
		).toBe(true);
	});

	it("detects marker with extra whitespace in JSON", () => {
		const sniffer = createSseRateLimitSniffer();
		const frame = encode(
			'event: error\ndata: {"type" : "error", "error": {"type" :  "rate_limit_error"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(true);
	});
});
