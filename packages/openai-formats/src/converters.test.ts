import { describe, expect, it } from "bun:test";
import { convertOpenAIResponseToAnthropic } from "./converters";

describe("convertOpenAIResponseToAnthropic — flat gateway rejection bodies", () => {
	it("passes through the real CodeBuddy {code, msg} rejection message", () => {
		// Live rejection observed 2026-10-29: a flat envelope with no `error`
		// object and no `choices`. Used to become the generic
		// "Invalid response format from OpenAI provider", hiding the cause.
		const result = convertOpenAIResponseToAnthropic({
			code: 11128,
			msg: "Illegal API invocation from an unapproved channel",
			requestId: "b782247b6b7f414faea7a2051081b449",
		} as never);

		expect(result.type).toBe("error");
		expect(result.error?.type).toBe("invalid_request_error");
		expect(result.error?.message).toContain("11128");
		expect(result.error?.message).toContain(
			"Illegal API invocation from an unapproved channel",
		);
	});

	it("keeps the generic invalid_response body for shapeless payloads", () => {
		const result = convertOpenAIResponseToAnthropic({} as never);

		expect(result.type).toBe("error");
		expect(result.error?.type).toBe("invalid_response");
		expect(result.error?.message).toBe(
			"Invalid response format from OpenAI provider",
		);
	});

	it("flattens Mistral's nested pydantic detail into readable text", () => {
		// Mistral 422 (captured live 2026-11-03). Its `message` is an object, so
		// a client reached only when the cache_control retry also fails would
		// otherwise see "[object Object]" / the generic invalid_response text.
		const result = convertOpenAIResponseToAnthropic({
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
		} as never);

		expect(result.type).toBe("error");
		expect(result.error?.type).toBe("invalid_request_error");
		expect(result.error?.message).toContain("body.thinking");
		expect(result.error?.message).toContain("Extra inputs are not permitted");
		expect(result.error?.message).not.toContain("[object Object]");
	});
});
