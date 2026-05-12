import { describe, expect, test } from "bun:test";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
});

describe("handleResponsesRequest", () => {
	test("Test 1: invalid request (no input field) → 400", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("should not be called", { status: 200 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "claude-haiku-4-5" }), // no input
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(400);

		const body = await resp.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
	});

	test("Test 2: non-streaming path → calls handleProxy with /v1/messages, returns translated response", async () => {
		let capturedUrl: URL | null = null;

		const mockHandleProxy: HandleProxyFn = async (_req, url) => {
			capturedUrl = url;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);

		expect(capturedUrl?.pathname).toBe("/v1/messages");
		expect(resp.status).toBe(200);

		const body = await resp.json();
		expect(body.object).toBe("response");
		expect(Array.isArray(body.output)).toBe(true);
		expect(body.output[0].type).toBe("message");
	});

	test("Test 3: error passthrough → if handleProxy returns 429, handler returns 429", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("rate limited", { status: 429 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(429);
	});

	test("Test 4: streaming path → returns a text/event-stream response", async () => {
		const sseBody =
			"data: " +
			JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-haiku-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}) +
			"\n\n" +
			"data: " +
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			}) +
			"\n\n" +
			"data: " +
			JSON.stringify({ type: "message_stop" }) +
			"\n\n";

		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: true,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");
	});
});
