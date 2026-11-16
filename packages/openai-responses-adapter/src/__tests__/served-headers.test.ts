import { describe, expect, test } from "bun:test";
import {
	SERVED_ACCOUNT_HEADER,
	SERVED_MODEL_HEADER,
} from "@better-ccflare/core";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

/**
 * /v1/responses builds its own Response from the proxied /v1/messages one.
 * The served model/account headers the proxy set must survive that
 * translation on every path, or a Responses client could never see which
 * account and model a combo alias actually resolved to.
 */

const SERVED = {
	[SERVED_MODEL_HEADER]: "glm-5.1",
	[SERVED_ACCOUNT_HEADER]: "zai-slot",
};

function makeRequest(stream: boolean, model = "combo-alias"): Request {
	return new Request("http://localhost/v1/responses", {
		method: "POST",
		body: JSON.stringify({
			model,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Hi" }],
				},
			],
			stream,
		}),
		headers: { "Content-Type": "application/json" },
	});
}

async function run(
	upstream: () => Response,
	stream: boolean,
): Promise<Response> {
	const mockHandleProxy: HandleProxyFn = async () => upstream();
	const req = makeRequest(stream);
	return handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});
}

function expectServed(resp: Response) {
	expect(resp.headers.get(SERVED_MODEL_HEADER)).toBe("glm-5.1");
	expect(resp.headers.get(SERVED_ACCOUNT_HEADER)).toBe("zai-slot");
}

const ANTHROPIC_MESSAGE = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "combo-alias",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
});

const ANTHROPIC_SSE =
	`event: message_start\ndata: ${JSON.stringify({
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "combo-alias",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	})}\n\n` +
	`event: content_block_start\ndata: ${JSON.stringify({
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	})}\n\n` +
	`event: content_block_delta\ndata: ${JSON.stringify({
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "Hello" },
	})}\n\n` +
	`event: content_block_stop\ndata: ${JSON.stringify({
		type: "content_block_stop",
		index: 0,
	})}\n\n` +
	`event: message_delta\ndata: ${JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 5 },
	})}\n\n` +
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;

describe("handleResponsesRequest — served model/account headers survive translation", () => {
	test("translated non-stream response keeps the served headers", async () => {
		const resp = await run(
			() =>
				new Response(ANTHROPIC_MESSAGE, {
					status: 200,
					headers: { "Content-Type": "application/json", ...SERVED },
				}),
			false,
		);
		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toContain("application/json");
		expectServed(resp);
		const body = (await resp.json()) as { object: string; model: string };
		expect(body.object).toBe("response");
	});

	test("translated stream response keeps the served headers", async () => {
		const resp = await run(
			() =>
				new Response(ANTHROPIC_SSE, {
					status: 200,
					headers: { "Content-Type": "text/event-stream", ...SERVED },
				}),
			true,
		);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");
		expectServed(resp);
		const raw = await resp.text();
		expect(raw).toContain("response.completed");
	});

	test("native Responses stream passthrough keeps the served headers", async () => {
		const sse = `event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_1", model: "gpt-5.1-codex", output: [] },
		})}\n\n`;
		const resp = await run(
			() =>
				new Response(sse, {
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"x-better-ccflare-codex-response-format": "responses-api",
						...SERVED,
					},
				}),
			true,
		);
		expectServed(resp);
		expect(await resp.text()).toBe(sse);
	});

	test("native Responses non-stream passthrough keeps the served headers", async () => {
		const resp = await run(
			() =>
				new Response(
					JSON.stringify({ id: "resp_1", model: "gpt-5.1-codex", output: [] }),
					{
						status: 200,
						headers: {
							"Content-Type": "application/json",
							"x-better-ccflare-codex-response-format": "responses-api",
							...SERVED,
						},
					},
				),
			false,
		);
		expect(resp.status).toBe(200);
		expectServed(resp);
	});

	test("upstream error keeps the served headers", async () => {
		const resp = await run(
			() =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: "bad" },
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json", ...SERVED },
					},
				),
			false,
		);
		expect(resp.status).toBe(400);
		expectServed(resp);
	});

	test("an unparseable upstream body still reports who served it", async () => {
		const resp = await run(
			() =>
				new Response("not json", {
					status: 200,
					headers: { "Content-Type": "application/json", ...SERVED },
				}),
			false,
		);
		expect(resp.status).toBe(502);
		expectServed(resp);
	});

	test("no served headers are invented when the proxy set none", async () => {
		const resp = await run(
			() =>
				new Response(ANTHROPIC_MESSAGE, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			false,
		);
		expect(resp.headers.has(SERVED_MODEL_HEADER)).toBe(false);
		expect(resp.headers.has(SERVED_ACCOUNT_HEADER)).toBe(false);
	});
});
