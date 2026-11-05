import { describe, expect, it } from "bun:test";
import { RequestBodyContext } from "../../request-body-context";
import {
	isVisionUnsupportedError,
	requestCarriesImageContent,
} from "../proxy-operations";

/**
 * Covers the failover predicate for "this model cannot read images".
 *
 * The proxy converts Anthropic image blocks to OpenAI `image_url` parts for
 * every account (see `toOpenAIImagePart`), because better-ccflare has no way
 * to know which models accept images across the gateways it fronts. The
 * contract is therefore: assume every model supports vision, and when one
 * answers with a rejection that names image *input*, treat it like an
 * unavailable model and try the next combo slot / account.
 *
 * The matcher is deliberately narrow. Only a rejection that names the input
 * side of the request counts, so an unrelated 400 that merely mentions the
 * word "image" (billing, content policy, output formats) is forwarded to the
 * client exactly as before.
 */

function jsonResponse(body: unknown, status = 400): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("isVisionUnsupportedError", () => {
	it("recognises OpenRouter's 'no endpoints found that support image input'", async () => {
		const res = jsonResponse({
			error: {
				code: 404,
				message: "No endpoints found that support image input.",
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	it("recognises 'model does not support image input' in a flat message", async () => {
		const res = jsonResponse({
			error: { message: "This model does not support image input." },
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	it("recognises a rejection that names image_url", async () => {
		const res = jsonResponse({
			error: {
				message: "messages.0.content.1.image_url: unknown field",
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	it("recognises DashScope's invalid content type for image parts", async () => {
		const res = jsonResponse({
			error: {
				message: "Invalid content type: image. Supported content types: text.",
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	it("recognises the nested pydantic detail shape", async () => {
		const res = jsonResponse({
			object: "error",
			message: {
				detail: [
					{
						type: "literal_error",
						loc: ["body", "messages", 0, "content", 1, "type"],
						msg: "Input should be 'text'; image_url is not supported",
					},
				],
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	// The image noun lives in `loc` while the rejection lives in `msg`. Testing
	// them as separate strings can never match, because the matcher requires
	// both halves together — so each entry is scored on its combined text.
	it("matches a pydantic entry whose loc and msg split the two halves", async () => {
		const res = jsonResponse({
			object: "error",
			message: {
				detail: [
					{
						type: "extra_forbidden",
						loc: ["body", "messages", 0, "content", 1, "image_url"],
						msg: "Extra inputs are not permitted",
					},
				],
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	it("matches an unknown-field entry that names image_url only in loc", async () => {
		const res = jsonResponse({
			error: {
				message: {
					detail: [
						{
							loc: ["messages", 0, "content", 2, "image_url"],
							msg: "unknown field",
						},
					],
				},
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	it("still excludes a malformed-payload entry when loc names image_url", async () => {
		const res = jsonResponse({
			error: {
				message: {
					detail: [
						{
							loc: ["messages", 0, "content", 1, "image_url"],
							msg: "invalid base64 data",
						},
					],
				},
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("ignores non-400 statuses", async () => {
		const body = { error: { message: "model does not support image input" } };
		expect(await isVisionUnsupportedError(jsonResponse(body, 429))).toBe(false);
		expect(await isVisionUnsupportedError(jsonResponse(body, 500))).toBe(false);
	});

	it("does not treat an anthropic overload error as vision unsupported", async () => {
		const res = jsonResponse({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("does not treat a billing error mentioning images as unsupported", async () => {
		const res = jsonResponse({
			error: {
				message:
					"Your credit balance is too low to access this model's image features.",
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("does not treat a content-policy rejection as unsupported", async () => {
		const res = jsonResponse({
			error: { message: "This image was rejected by the content filter." },
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("does not treat a model-not-found 400 as unsupported", async () => {
		const res = jsonResponse({
			error: { code: "model_not_found", message: "Model not found" },
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("returns false for a non-JSON body", async () => {
		const res = new Response("image not supported", {
			status: 400,
			headers: { "content-type": "text/plain" },
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	// ── Naming an image is not the same as denying a capability ──────────────
	// Failing over on these would replay a broken request across every account
	// and end in a generic error instead of the useful 400.

	it("does not fail over on malformed image data", async () => {
		const res = jsonResponse({
			error: { message: "Invalid image_url: invalid base64 data" },
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("does not fail over on an oversized image", async () => {
		const res = jsonResponse({
			error: {
				message: "Image dimensions exceed the maximum size of 8000px.",
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("does not fail over when the image decodes but is corrupt", async () => {
		const res = jsonResponse({
			error: { message: "Could not decode image content: corrupt PNG header" },
		});
		expect(await isVisionUnsupportedError(res)).toBe(false);
	});

	it("fails over when the gateway schema rejects image_url outright", async () => {
		// A schema that cannot even represent an image part is a capability
		// limit (GLM-style "unknown field", pydantic "Extra inputs are not
		// permitted"), unlike a malformed payload, which is excluded above.
		const res = jsonResponse({
			error: {
				message:
					"messages.0.content.1: Extra inputs are not permitted (image_url)",
			},
		});
		expect(await isVisionUnsupportedError(res)).toBe(true);
	});

	// ── Capability phrasing that must still match ────────────────────────────

	it("matches capability wording that names an image noun", async () => {
		for (const message of [
			"The selected model does not accept image input.",
			"Images are not supported by this model.",
			"This endpoint only supports text; multimodal input is unavailable.",
			"model qwen3-coder-plus does not support vision",
		]) {
			expect(
				await isVisionUnsupportedError(jsonResponse({ error: { message } })),
			).toBe(true);
		}
	});
});

/**
 * The request-side half of the same decision. The matcher above reads an
 * upstream's wording, and its image nouns include `file`, `attachment` and
 * `modality` — so it is only safe to act on when the request really carried an
 * image. This gate is what keeps a text-only request's unrelated 400 from being
 * replayed across every account (see proxy-operations-failover.test.ts).
 */
describe("requestCarriesImageContent", () => {
	function contextFor(body: unknown): RequestBodyContext {
		return new RequestBodyContext(
			new TextEncoder().encode(JSON.stringify(body)).buffer,
		);
	}

	it("sees a message-level Anthropic image block", () => {
		expect(
			requestCarriesImageContent(
				contextFor({
					model: "claude-sonnet-4-5",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "what is this" },
								{
									type: "image",
									source: {
										type: "base64",
										media_type: "image/png",
										data: "a",
									},
								},
							],
						},
					],
				}),
			),
		).toBe(true);
	});

	// The shape Claude Code actually produces for a tool-made screenshot: the
	// image is nested inside the tool_result, not at message level.
	it("sees an image nested in a tool_result", () => {
		expect(
			requestCarriesImageContent(
				contextFor({
					messages: [
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "toolu_1",
									content: [
										{ type: "text", text: "screenshot taken" },
										{
											type: "image",
											source: {
												type: "base64",
												media_type: "image/png",
												data: "a",
											},
										},
									],
								},
							],
						},
					],
				}),
			),
		).toBe(true);
	});

	it("sees an OpenAI image_url part", () => {
		expect(
			requestCarriesImageContent(
				contextFor({
					messages: [
						{
							role: "user",
							content: [
								{ type: "image_url", image_url: { url: "https://x/y.png" } },
							],
						},
					],
				}),
			),
		).toBe(true);
	});

	it("is false for a text-only request", () => {
		expect(
			requestCarriesImageContent(
				contextFor({
					messages: [{ role: "user", content: "hello" }],
				}),
			),
		).toBe(false);
		expect(
			requestCarriesImageContent(
				contextFor({
					messages: [
						{ role: "user", content: [{ type: "text", text: "hello" }] },
						{
							role: "assistant",
							content: [{ type: "tool_use", id: "t", name: "n", input: {} }],
						},
					],
				}),
			),
		).toBe(false);
	});

	// Why this walks the parsed body instead of scanning bytes: a Claude Code
	// conversation routinely carries source code and JSON samples, so the literal
	// `"type":"image"` inside a text block is ordinary traffic, not an image.
	it("is false when a text block merely contains the literal image marker", () => {
		expect(
			requestCarriesImageContent(
				contextFor({
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: 'emit {"type":"image","source":{...}} here',
								},
							],
						},
					],
				}),
			),
		).toBe(false);
	});

	it("is false for a body with no messages, a null context and an unparseable body", () => {
		expect(requestCarriesImageContent(contextFor({ model: "x" }))).toBe(false);
		expect(requestCarriesImageContent(contextFor({ messages: "nope" }))).toBe(
			false,
		);
		expect(requestCarriesImageContent(null)).toBe(false);
		expect(requestCarriesImageContent(undefined)).toBe(false);
		expect(
			requestCarriesImageContent(
				new RequestBodyContext(new TextEncoder().encode("not json").buffer),
			),
		).toBe(false);
	});

	it("ignores non-object entries instead of throwing", () => {
		expect(
			requestCarriesImageContent(
				contextFor({
					messages: [
						null,
						"text",
						{ role: "user", content: [null, 7, { type: "text" }] },
					],
				}),
			),
		).toBe(false);
	});
});
