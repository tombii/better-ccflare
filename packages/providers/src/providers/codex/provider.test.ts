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
