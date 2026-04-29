import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";
import { parseCodexUsageHeaders } from "./usage";

describe("CodexProvider.processResponse", () => {
	it("transforms streaming responses even when Codex returns the wrong content-type", async () => {
		const provider = new CodexProvider();
		const upstreamBody = [
			"event: response.created",
			'data: {"response":{"id":"resp_test","model":"gpt-5.3-codex"}}',
			"",
			"event: response.output_item.added",
			'data: {"item":{"type":"message"},"output_index":0}',
			"",
			"event: response.content_part.added",
			'data: {"part":{"type":"output_text"}}',
			"",
			"event: response.output_text.delta",
			'data: {"delta":"hello"}',
			"",
			"event: response.output_item.done",
			'data: {"item":{"type":"message"}}',
			"",
			"event: response.completed",
			'data: {"response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
			"",
		].join("\n");

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformed.headers.get("content-type")).toBe("text/event-stream");
		expect(transformedBody).toContain("event: message_start");
		expect(transformedBody).toContain('"text":"hello"');
		expect(transformedBody.match(/event: message_stop/g)?.length ?? 0).toBe(1);
		expect(transformedBody.match(/event: message_delta/g)?.length ?? 0).toBe(1);
	});

	it("passes through non-streaming error responses", async () => {
		const provider = new CodexProvider();
		const response = new Response('{"error":"bad_request"}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});

		const processed = await provider.processResponse(response, null);

		expect(processed.status).toBe(400);
		expect(await processed.text()).toBe('{"error":"bad_request"}');
	});

	it("maps response.completed context usage into Claude-compatible context_window", async () => {
		const provider = new CodexProvider();
		const upstreamBody = [
			"event: response.created",
			'data: {"response":{"id":"resp_test","model":"gpt-5.3-codex"}}',
			"",
			"event: response.completed",
			'data: {"response":{"usage":{"input_tokens":100,"output_tokens":50,"input_tokens_details":{"cached_tokens":25,"cache_creation_input_tokens":10}},"context_window":{"current_usage":{"input_tokens":100,"cache_read_input_tokens":25,"cache_creation_input_tokens":10},"context_window_size":200000}}}',
			"",
		].join("\n");

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"input_tokens":100');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":25');
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":10');
		expect(messageDeltaLine).toContain('"context_window_size":200000');
	});

	it("defaults missing cache fields to zero when context window size is present", async () => {
		const provider = new CodexProvider();
		const upstreamBody = [
			"event: response.created",
			'data: {"response":{"id":"resp_test","model":"gpt-5.3-codex"}}',
			"",
			"event: response.completed",
			'data: {"response":{"usage":{"input_tokens":42,"output_tokens":7},"context_window":{"current_usage":{"input_tokens":42},"context_window_size":128000}}}',
			"",
		].join("\n");

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"input_tokens":42');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":0');
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":0');
	});

	it("omits malformed context_window when context_window_size is missing", async () => {
		const provider = new CodexProvider();
		const upstreamBody = [
			"event: response.created",
			'data: {"response":{"id":"resp_test","model":"gpt-5.3-codex"}}',
			"",
			"event: response.completed",
			'data: {"response":{"usage":{"input_tokens":12,"output_tokens":3,"input_tokens_details":{"cached_tokens":4}}}}',
			"",
		].join("\n");

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toContain('"context_window"');
		expect(messageDeltaLine).toContain('"output_tokens":3');
	});
});

describe("CodexProvider.transformRequestBody", () => {
	it("maps sonnet-family models to the default Codex model", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex");
	});

	it("passes through unknown model names unchanged", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.4-mini");
	});
});

describe("parseCodexUsageHeaders", () => {
	it("normalizes primary and secondary codex quota headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "4",
			"x-codex-secondary-window-minutes": "300",
			"x-codex-secondary-reset-at": "1774600000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).not.toBeNull();
		expect(usage?.five_hour).toEqual({
			utilization: 4,
			resets_at: new Date(1774600000 * 1000).toISOString(),
		});
		expect(usage?.seven_day).toEqual({
			utilization: 11,
			resets_at: new Date(1775000000 * 1000).toISOString(),
		});
	});

	it("ignores empty secondary placeholders when primary is seven-day usage", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "0",
			"x-codex-secondary-window-minutes": "0",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).toEqual({
			five_hour: {
				utilization: 0,
				resets_at: null,
			},
			seven_day: {
				utilization: 11,
				resets_at: new Date(1775000000 * 1000).toISOString(),
			},
		});
	});

	it("falls back to legacy reset headers when utilization headers are missing", () => {
		const headers = new Headers({
			"x-codex-5h-reset-at": "1774600000",
			"x-codex-7d-reset-at": "1775000000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).toEqual({
			five_hour: {
				utilization: 0,
				resets_at: new Date(1774600000 * 1000).toISOString(),
			},
			seven_day: {
				utilization: 0,
				resets_at: new Date(1775000000 * 1000).toISOString(),
			},
		});
	});

	it("returns null when no Codex usage headers are present", () => {
		expect(parseCodexUsageHeaders(new Headers())).toBeNull();
	});

	it("drops invalid reset timestamps instead of throwing", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1e309",
		});

		expect(parseCodexUsageHeaders(headers)).toEqual({
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: 0, resets_at: null },
		});
	});
});

describe("parseCodexUsageHeaders reset-after handling", () => {
	it("uses the supplied base time for relative reset headers", () => {
		const baseTimeMs = Date.UTC(2026, 2, 27, 16, 0, 0);
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-after-seconds": "600",
		});

		const usage = parseCodexUsageHeaders(headers, {
			baseTimeMs,
			allowRelativeResetAfter: true,
		});

		expect(usage?.five_hour?.resets_at).toBe(
			new Date(baseTimeMs + 600_000).toISOString(),
		);
	});
});
