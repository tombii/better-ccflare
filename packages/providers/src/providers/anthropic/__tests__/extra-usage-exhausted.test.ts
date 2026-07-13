import { describe, expect, it } from "bun:test";
import {
	EXTRA_USAGE_EXHAUSTED_REASON,
	isAnthropicExtraUsageExhausted,
} from "../provider";

const EXTRA_USAGE_MESSAGE =
	"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";

function jsonResponse(
	status: number,
	body: unknown,
	contentType = "application/json",
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": contentType },
	});
}

describe("isAnthropicExtraUsageExhausted", () => {
	it("the exported reason constant is 'extra_usage_exhausted'", () => {
		expect(EXTRA_USAGE_EXHAUSTED_REASON).toBe("extra_usage_exhausted");
	});

	it("returns true for a 400 invalid_request_error mentioning extra usage", async () => {
		const response = jsonResponse(400, {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		});

		expect(await isAnthropicExtraUsageExhausted(response)).toBe(true);
	});

	it("returns false for a 429 response regardless of body (status short-circuits)", async () => {
		const response = jsonResponse(429, {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		});

		expect(await isAnthropicExtraUsageExhausted(response)).toBe(false);
	});

	it("returns false for a 400 invalid_request_error whose message does not mention extra usage", async () => {
		const response = jsonResponse(400, {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "max_tokens: field required",
			},
		});

		expect(await isAnthropicExtraUsageExhausted(response)).toBe(false);
	});

	it("returns false for a 400 response with non-JSON content-type", async () => {
		const response = new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: EXTRA_USAGE_MESSAGE,
				},
			}),
			{
				status: 400,
				headers: { "content-type": "text/plain" },
			},
		);

		expect(await isAnthropicExtraUsageExhausted(response)).toBe(false);
	});

	it("returns false for a 400 response with malformed JSON (exercises catch block)", async () => {
		const response = new Response("{not valid json", {
			status: 400,
			headers: { "content-type": "application/json" },
		});

		expect(await isAnthropicExtraUsageExhausted(response)).toBe(false);
	});

	it("returns false when error.type is not invalid_request_error even if message mentions extra usage", async () => {
		const response = jsonResponse(400, {
			type: "error",
			error: {
				type: "not_found_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		});

		expect(await isAnthropicExtraUsageExhausted(response)).toBe(false);
	});

	it("matches the message case-insensitively", async () => {
		const response = jsonResponse(400, {
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "THIRD-PARTY APPS NOW DRAW FROM YOUR EXTRA USAGE.",
			},
		});

		expect(await isAnthropicExtraUsageExhausted(response)).toBe(true);
	});
});
