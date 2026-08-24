import { expect, test } from "bun:test";
import { CodexProvider } from "./provider";

test("preserves custom tool calls in labeled Codex SSE", async () => {
	const provider = new CodexProvider();
	const stream = [
		"event: response.custom_tool_call_input.done\n",
		'data: {"type":"response.custom_tool_call_input.done"}\n\n',
	].join("");
	const response = new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"x-better-ccflare-request-stream": "true",
			"x-better-ccflare-codex-custom-tools": "true",
		},
	});

	const transformed = await provider.processResponse(response, null);

	expect(
		transformed.headers.get("x-better-ccflare-codex-response-format"),
	).toBe("responses-api");
	expect(await transformed.text()).toBe(stream);
});

test("passes custom-tool streams through without waiting for upstream EOF", async () => {
	const provider = new CodexProvider();
	const encoder = new TextEncoder();
	const firstChunk = [
		"event: response.output_text.delta\n",
		'data: {"type":"response.output_text.delta","delta":"still reasoning"}\n\n',
	].join("");
	// Stream stays open after the first chunk, like an upstream mid-generation.
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(firstChunk));
		},
	});
	const response = new Response(body, {
		headers: {
			"content-type": "text/event-stream",
			"x-better-ccflare-request-stream": "true",
			"x-better-ccflare-codex-custom-tools": "true",
		},
	});

	const transformed = await provider.processResponse(response, null);

	expect(
		transformed.headers.get("x-better-ccflare-codex-response-format"),
	).toBe("responses-api");
	const reader = transformed.body?.getReader();
	if (!reader) throw new Error("expected a streaming body");
	const { value } = await reader.read();
	expect(new TextDecoder().decode(value)).toBe(firstChunk);
	await reader.cancel();
});

test("streams straight through without buffering when no custom tools were declared", async () => {
	const provider = new CodexProvider();
	// Body text mentions the marker string, but no custom tool was declared,
	// so this must not trigger passthrough detection.
	const stream = [
		"event: response.output_text.delta\n",
		'data: {"type":"response.output_text.delta","delta":"custom_tool_call is a feature"}\n\n',
	].join("");
	const response = new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"x-better-ccflare-request-stream": "true",
			"x-better-ccflare-codex-custom-tools": "false",
		},
	});

	const transformed = await provider.processResponse(response, null);

	expect(
		transformed.headers.get("x-better-ccflare-codex-response-format"),
	).not.toBe("responses-api");
});

test("surfaces malformed Codex model-list responses as an error instead of an empty success", async () => {
	const provider = new CodexProvider();
	const response = new Response("not json", {
		status: 200,
		headers: { "x-better-ccflare-request-path": "/v1/models" },
	});

	const transformed = await provider.processResponse(response, null);

	expect(transformed.status).toBe(502);
	const body = (await transformed.json()) as { error?: { type?: string } };
	expect(body.error?.type).toBe("api_error");
});

test("passes through non-2xx Codex model-list responses unchanged", async () => {
	const provider = new CodexProvider();
	const response = new Response("upstream down", {
		status: 503,
		headers: { "x-better-ccflare-request-path": "/v1/models" },
	});

	const transformed = await provider.processResponse(response, null);

	expect(transformed.status).toBe(503);
	expect(await transformed.text()).toBe("upstream down");
});
