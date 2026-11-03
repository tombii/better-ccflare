import { describe, expect, it } from "bun:test";
import { isCacheControlRejectionError } from "../proxy-operations";

/**
 * Covers the shapes that make the proxy retry a request without
 * `cache_control` and mark the (account, model) pair as a rejector.
 *
 * `cache_control` is Anthropic's prompt-caching marker, not part of the OpenAI
 * chat-completions schema, so strict OpenAI-compatible endpoints reject it as
 * an unknown field. Two shapes have been observed live:
 *   - GLM-5.1: flat string message, HTTP 400.
 *   - Mistral: nested `message.detail[]` pydantic errors, HTTP 422. Without
 *     this the 422 falls through to the client as a terminal error and the
 *     whole request is lost (observed 2026-11-03, `deepseek-v4-1-flash-1017`).
 */

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("isCacheControlRejectionError", () => {
	it("recognises the flat GLM-style 400", async () => {
		const res = jsonResponse(
			{
				error: {
					message:
						"Extra inputs are not permitted: cache_control is not a valid field",
				},
			},
			400,
		);
		expect(await isCacheControlRejectionError(res)).toBe(true);
	});

	it("recognises Mistral's nested 422 detail", async () => {
		// Shape captured live from api.mistral.ai: the error is not wrapped in
		// `error`, and `message` is an object, not a string.
		const res = jsonResponse(
			{
				object: "error",
				message: {
					detail: [
						{
							type: "extra_forbidden",
							loc: [
								"body",
								"messages",
								0,
								"system",
								"content",
								0,
								"cache_control",
							],
							msg: "Extra inputs are not permitted",
						},
					],
				},
			},
			422,
		);
		expect(await isCacheControlRejectionError(res)).toBe(true);
	});

	it("recognises Mistral's long union-branch loc from the real API", async () => {
		// Verbatim shape captured from the live API 2026-11-03 (truncated): the
		// `string_type` branch has no cache_control in its loc at all, and the
		// union branch reports the field name only in `msg`. Matching only on
		// loc missed this and the 422 went through to the client.
		const res = jsonResponse(
			{
				detail: [
					{
						type: "string_type",
						loc: ["body", "messages", 0, "system", "content", "str"],
						msg: "Input should be a valid string",
					},
					{
						type: "extra_forbidden",
						loc: [
							"body",
							"messages",
							0,
							"system",
							"content",
							"list[tagged-union[...,ThinkChunk,TranscriptionSegmentChunk,...]]",
							0,
							"text",
							"cache_control",
						],
						msg: "Extra inputs are not permitted",
					},
				],
			},
			422,
		);
		expect(await isCacheControlRejectionError(res)).toBe(true);
	});

	it("matches when the field name appears only in msg, not loc", async () => {
		// The union-branch entry names the field in `msg` rather than `loc`, so
		// this fails if the msgText match is dropped.
		const res = jsonResponse(
			{
				detail: [
					{
						type: "extra_forbidden",
						loc: ["body", "messages", 0, "system", "content", 0],
						msg: "Extra inputs are not permitted: cache_control",
					},
				],
			},
			422,
		);
		expect(await isCacheControlRejectionError(res)).toBe(true);
	});

	it("ignores a 422 about an unrelated field", async () => {
		// Mistral answers 422 for Anthropic-only fields too (`thinking`,
		// `output_config`). Retrying those without cache_control cannot help,
		// so they must not mark the pair.
		const res = jsonResponse(
			{
				object: "error",
				message: {
					detail: [
						{
							type: "extra_forbidden",
							loc: ["body", "thinking"],
							msg: "Extra inputs are not permitted",
						},
					],
				},
			},
			422,
		);
		expect(await isCacheControlRejectionError(res)).toBe(false);
	});

	it("ignores statuses other than 400 and 422", async () => {
		const res = jsonResponse({ message: "cache_control Extra inputs" }, 500);
		expect(await isCacheControlRejectionError(res)).toBe(false);
	});
});
