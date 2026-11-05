import { describe, expect, it } from "bun:test";
import { isVisionUnsupportedError } from "../proxy-operations";

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
