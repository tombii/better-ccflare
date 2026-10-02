import { describe, expect, it } from "bun:test";
import { shouldParseSSEData } from "../usage-collector";

describe("shouldParseSSEData", () => {
	it("skips plain content_block_delta events", () => {
		const text =
			'{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}';
		expect(shouldParseSSEData(text, "content_block_delta")).toBe(false);
	});

	it("skips content_block_delta whose text mentions a quoted usage word", () => {
		const data = JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: 'say "usage" please' },
		});
		expect(shouldParseSSEData(data, "content_block_delta")).toBe(false);
	});

	it("still parses content_block_delta that carries a usage field", () => {
		const data =
			'{"type":"content_block_delta","index":0,"delta":{},"usage":{"output_tokens":3}}';
		expect(shouldParseSSEData(data, "content_block_delta")).toBe(true);
	});

	it("still parses usage-bearing and start events", () => {
		expect(
			shouldParseSSEData('{"type":"message_start"}', "message_start"),
		).toBe(true);
		expect(
			shouldParseSSEData('{"usage":{"output_tokens":1}}', "message_delta"),
		).toBe(true);
		expect(
			shouldParseSSEData(
				'{"type":"content_block_start"}',
				"content_block_start",
			),
		).toBe(true);
		expect(
			shouldParseSSEData('{"response":{"usage":{}}}', "response.completed"),
		).toBe(true);
	});
});
