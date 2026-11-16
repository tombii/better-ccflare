import { describe, expect, it } from "bun:test";
import { getRejectedReasoningField } from "../proxy-operations";

/**
 * Covers the shapes that make the proxy retry a request without the client's
 * reasoning effort and mark the (account, model) pair as a rejector.
 *
 * The effort reaches an OpenAI-compatible upstream as `reasoning_effort` (the
 * standard Chat Completions field) or as `reasoning: { effort }` (the
 * OpenRouter shape). Both are optional extensions, so a strict schema rejects
 * them as unknown fields and the whole request is lost unless the proxy
 * retries without them.
 *
 * `reasoning` is a substring of both `reasoning_effort` and
 * `reasoning_content`. `reasoning_content` is a different field that the
 * Mistral transform rewrites on its own; a rejection of it must never be
 * mistaken for a rejection of the effort, because stripping the effort would
 * leave the actual error in place.
 */

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function mistralDetail(
	loc: Array<string | number>,
	msg = "Extra inputs are not permitted",
): Response {
	return jsonResponse(
		{
			object: "error",
			message: {
				detail: [{ type: "extra_forbidden", loc, msg }],
			},
		},
		422,
	);
}

describe("getRejectedReasoningField", () => {
	it("recognises Mistral's 422 detail naming reasoning_effort", async () => {
		const res = mistralDetail(["body", "reasoning_effort"]);
		expect(await getRejectedReasoningField(res)).toBe("reasoning_effort");
	});

	it("recognises Mistral's 422 detail naming reasoning", async () => {
		const res = mistralDetail(["body", "reasoning"]);
		expect(await getRejectedReasoningField(res)).toBe("reasoning");
	});

	it("recognises a top-level detail array", async () => {
		// Mistral wraps the same array in `message` only on some paths.
		const res = jsonResponse(
			{
				detail: [
					{
						type: "extra_forbidden",
						loc: ["body", "reasoning_effort"],
						msg: "Extra inputs are not permitted",
					},
				],
			},
			422,
		);
		expect(await getRejectedReasoningField(res)).toBe("reasoning_effort");
	});

	it("recognises the flat GLM-style message", async () => {
		const res = jsonResponse(
			{
				error: {
					message:
						"Extra inputs are not permitted: reasoning_effort is not a valid field",
				},
			},
			400,
		);
		expect(await getRejectedReasoningField(res)).toBe("reasoning_effort");
	});

	it("recognises a flat unknown-field message naming reasoning", async () => {
		const res = jsonResponse(
			{ error: { message: "unknown field: reasoning" } },
			400,
		);
		expect(await getRejectedReasoningField(res)).toBe("reasoning");
	});

	it("does not match a reasoning_content rejection", async () => {
		// `reasoning` is a substring of `reasoning_content`. Stripping the
		// effort would not fix this error, so it must not mark the pair.
		const res = mistralDetail(["body", "messages", 0, "reasoning_content"]);
		expect(await getRejectedReasoningField(res)).toBeNull();
	});

	it("does not match reasoning_content in a flat message", async () => {
		const res = jsonResponse(
			{
				error: {
					message:
						"Extra inputs are not permitted: reasoning_content is not a valid field",
				},
			},
			400,
		);
		expect(await getRejectedReasoningField(res)).toBeNull();
	});

	it("ignores an unrelated 422", async () => {
		const res = mistralDetail(["body", "thinking"]);
		expect(await getRejectedReasoningField(res)).toBeNull();
	});

	it("ignores a non-JSON body", async () => {
		const res = new Response(
			"reasoning_effort: Extra inputs are not permitted",
			{
				status: 422,
				headers: { "content-type": "text/plain" },
			},
		);
		expect(await getRejectedReasoningField(res)).toBeNull();
	});

	it("ignores statuses other than 400 and 422", async () => {
		const res = mistralDetail(["body", "reasoning_effort"]);
		const res500 = new Response(await res.text(), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
		expect(await getRejectedReasoningField(res500)).toBeNull();
	});

	it("does not return a field for a non-strict rejection naming the field", async () => {
		// A validation error that mentions the field for another reason (e.g. a
		// range check) is not fixed by removing it.
		const res = jsonResponse(
			{ error: { message: "reasoning_effort must be one of low, high" } },
			400,
		);
		expect(await getRejectedReasoningField(res)).toBeNull();
	});
});
