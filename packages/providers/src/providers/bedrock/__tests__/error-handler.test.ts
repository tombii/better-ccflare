import { describe, expect, it, mock } from "bun:test";
import { translateBedrockError } from "../error-handler";

// Mock database dependencies used by getModelNotFoundSuggestion
mock.module("@better-ccflare/database", () => ({
	DatabaseFactory: {
		getInstance: mock(() => ({
			getDatabase: mock(() => ({})),
		})),
	},
	ModelTranslationRepository: mock(() => ({
		findSimilar: mock(() => []),
	})),
}));

describe("translateBedrockError", () => {
	describe("credential/auth errors → 403", () => {
		const credentialErrorNames = [
			"InvalidAccessKeyId",
			"SignatureDoesNotMatch",
			"ExpiredToken",
			"InvalidClientTokenId",
			"UnrecognizedClientException",
			// streaming variants (camelCase)
			"invalidAccessKeyId",
			"signatureDoesNotMatch",
			"expiredToken",
		];

		for (const name of credentialErrorNames) {
			it(`maps ${name} to 403`, () => {
				const result = translateBedrockError({ name, message: "auth failed" });
				expect(result.statusCode).toBe(403);
				expect(result.message).toContain("AWS credentials invalid");
			});
		}
	});

	describe("throttling errors → 429", () => {
		it("maps ThrottlingException to 429", () => {
			const result = translateBedrockError({
				name: "ThrottlingException",
				message: "Rate exceeded",
				requestId: "req-123",
			});
			expect(result.statusCode).toBe(429);
			expect(result.message).toContain("ThrottlingException");
			expect(result.message).toContain("req-123");
		});

		it("maps throttlingException (camelCase) to 429", () => {
			const result = translateBedrockError({ name: "throttlingException" });
			expect(result.statusCode).toBe(429);
		});
	});

	describe("service errors → 503", () => {
		it("maps ServiceUnavailableException to 503", () => {
			const result = translateBedrockError({
				name: "ServiceUnavailableException",
			});
			expect(result.statusCode).toBe(503);
			expect(result.message).toContain("unavailable");
		});

		it("maps InternalServerException to 503", () => {
			const result = translateBedrockError({ name: "InternalServerException" });
			expect(result.statusCode).toBe(503);
		});
	});

	describe("model not found errors → 404", () => {
		it("maps ResourceNotFoundException to 404", () => {
			const result = translateBedrockError({
				name: "ResourceNotFoundException",
				message: "Model not found",
			});
			expect(result.statusCode).toBe(404);
			expect(result.message).toContain("ResourceNotFoundException");
		});

		it("includes error message in response", () => {
			const result = translateBedrockError({
				name: "ResourceNotFoundException",
				message: "The model anthropic.claude-3-sonnet does not exist",
			});
			expect(result.statusCode).toBe(404);
			expect(result.message).toContain(
				"The model anthropic.claude-3-sonnet does not exist",
			);
		});
	});

	describe("validation errors → 400", () => {
		it("maps ValidationException to 400", () => {
			const result = translateBedrockError({
				name: "ValidationException",
				message: "Invalid parameter value",
			});
			expect(result.statusCode).toBe(400);
			expect(result.message).toContain("Invalid parameter value");
		});
	});

	describe("unknown errors → 500", () => {
		it("maps unknown error names to 500", () => {
			const result = translateBedrockError({
				name: "SomeUnknownException",
				message: "Something went wrong",
			});
			expect(result.statusCode).toBe(500);
			expect(result.message).toContain("SomeUnknownException");
		});

		it("handles missing error name gracefully", () => {
			const result = translateBedrockError({ message: "no name" });
			expect(result.statusCode).toBe(500);
			expect(result.message).toContain("Unknown");
		});

		it("handles non-object errors gracefully", () => {
			const result = translateBedrockError("string error");
			expect(result.statusCode).toBe(500);
		});

		it("maps SerializationException to 500", () => {
			// Seen in logs: "SerializationException - Unexpected field type"
			const result = translateBedrockError({
				name: "SerializationException",
				message: "Unexpected field type",
			});
			expect(result.statusCode).toBe(500);
			expect(result.message).toContain("SerializationException");
		});
	});

	describe("requestId in throttling message", () => {
		it("uses unknown when requestId is absent", () => {
			const result = translateBedrockError({ name: "ThrottlingException" });
			expect(result.message).toContain("unknown");
		});
	});
});

describe("getModelNotFoundSuggestion regex patterns (via translateBedrockError)", () => {
	// These tests exercise the regex patterns inside getModelNotFoundSuggestion
	// indirectly through translateBedrockError with a ResourceNotFoundException.
	// With the DB mock returning no suggestions the suggestion string is empty,
	// but we verify the function doesn't throw or hang on adversarial input.

	describe("pattern 1: model'\"...'\": quoted model name", () => {
		it("handles: Model 'claude-3-5-sonnet' not found", () => {
			expect(() =>
				translateBedrockError({
					name: "ResourceNotFoundException",
					message: "Model 'claude-3-5-sonnet' not found",
				}),
			).not.toThrow();
		});

		it('handles: model": "anthropic.claude-3-sonnet-20240229-v1:0"', () => {
			expect(() =>
				translateBedrockError({
					name: "ResourceNotFoundException",
					message: 'model": "anthropic.claude-3-sonnet-20240229-v1:0"',
				}),
			).not.toThrow();
		});

		it('handles: model"="claude-3-opus"', () => {
			expect(() =>
				translateBedrockError({
					name: "ResourceNotFoundException",
					message: 'model"="claude-3-opus"',
				}),
			).not.toThrow();
		});
	});

	describe("pattern 2: foundation-model/... ARN path", () => {
		it("handles: arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0", () => {
			expect(() =>
				translateBedrockError({
					name: "ResourceNotFoundException",
					message:
						"Could not find model arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
				}),
			).not.toThrow();
		});
	});

	describe("pattern 3: model <name> plain word", () => {
		it("handles: model claude-3-opus not found", () => {
			expect(() =>
				translateBedrockError({
					name: "ResourceNotFoundException",
					message: "model claude-3-opus not found",
				}),
			).not.toThrow();
		});
	});

	describe("ReDoS safety: adversarial inputs must not hang", () => {
		// These strings match the pattern described in the CodeQL warning:
		// starts with 'model"' followed by many spaces (no closing quote).
		// With the old \s* regex these could cause catastrophic backtracking.

		it('does not hang on model" + 1000 spaces (no closing quote)', () => {
			const malicious = `model"${" ".repeat(1000)}`;
			const start = Date.now();
			translateBedrockError({
				name: "ResourceNotFoundException",
				message: malicious,
			});
			expect(Date.now() - start).toBeLessThan(100);
		});

		it('does not hang on model" + 1000 tabs (no closing quote)', () => {
			const malicious = `model"${"\t".repeat(1000)}`;
			const start = Date.now();
			translateBedrockError({
				name: "ResourceNotFoundException",
				message: malicious,
			});
			expect(Date.now() - start).toBeLessThan(100);
		});

		it("does not hang on model + 1000 spaces (no model name follows)", () => {
			const malicious = `model${" ".repeat(1000)}`;
			const start = Date.now();
			translateBedrockError({
				name: "ResourceNotFoundException",
				message: malicious,
			});
			expect(Date.now() - start).toBeLessThan(100);
		});
	});
});
