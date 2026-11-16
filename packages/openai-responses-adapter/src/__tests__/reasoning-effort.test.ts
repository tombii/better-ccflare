import { describe, expect, test } from "bun:test";
import { ValidationError } from "@better-ccflare/core";
import { REASONING_EFFORT_VALUES } from "@better-ccflare/openai-formats";
import { handleResponsesRequest } from "../handler";
import { translateRequestToAnthropic } from "../request-translator";
import type { ResponsesRequest } from "../types";

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

function baseRequest(reasoning?: unknown): ResponsesRequest {
	return {
		model: "claude-sonnet-4-6",
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Hi" }],
			},
		],
		...(reasoning === undefined ? {} : { reasoning }),
	} as ResponsesRequest;
}

describe("translateRequestToAnthropic reasoning effort", () => {
	test.each([
		...REASONING_EFFORT_VALUES,
	])("carries reasoning.effort=%s into the internal reasoning field", (effort) => {
		const result = translateRequestToAnthropic(
			baseRequest({ effort, summary: "auto" }) as ResponsesRequest & {
				input: never[];
			},
		);
		expect(result.reasoning).toEqual({ effort });
	});

	test("omits reasoning when the client sent no effort", () => {
		for (const reasoning of [
			undefined,
			{},
			{ summary: "auto" },
			{ effort: null },
		]) {
			const result = translateRequestToAnthropic(
				baseRequest(reasoning) as ResponsesRequest & { input: never[] },
			);
			expect(result.reasoning).toBeUndefined();
		}
	});

	test("rejects an invalid effort with a ValidationError", () => {
		expect(() =>
			translateRequestToAnthropic(
				baseRequest({ effort: "extreme" }) as ResponsesRequest & {
					input: never[];
				},
			),
		).toThrow(ValidationError);
	});
});

describe("handleResponsesRequest reasoning effort", () => {
	async function send(reasoning?: unknown) {
		let forwarded: Record<string, unknown> | null = null;
		let called = false;
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...baseRequest(reasoning), stream: false }),
		});
		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			async (proxied) => {
				called = true;
				forwarded = (await proxied.json()) as Record<string, unknown>;
				return new Response(ANTHROPIC_MESSAGE_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{},
		);
		return {
			resp,
			forwarded: forwarded as Record<string, unknown> | null,
			called,
		};
	}

	test("forwards reasoning.effort to the internal /v1/messages body", async () => {
		const { resp, forwarded } = await send({
			effort: "xhigh",
			summary: "auto",
		});
		expect(resp.status).toBe(200);
		expect(forwarded?.reasoning).toEqual({ effort: "xhigh" });
		// Codex passthrough keeps the client's original reasoning object.
		const passthrough = forwarded?.__better_ccflare_codex_passthrough as Record<
			string,
			unknown
		>;
		expect(passthrough.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
	});

	test("does not add reasoning when the client omitted it", async () => {
		const { forwarded } = await send();
		expect(forwarded?.reasoning).toBeUndefined();
	});

	test("rejects an invalid effort with 400 invalid_request_error", async () => {
		const { resp, called } = await send({ effort: "extreme" });
		expect(called).toBe(false);
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain("reasoning.effort must be one of");
	});
});
