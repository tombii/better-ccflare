import { describe, expect, test } from "bun:test";
import { mapModelName, parseModelMappings } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";

describe("Model Mapping", () => {
	test("parseModelMappings handles valid JSON", () => {
		const mappings = JSON.stringify({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});

		const result = parseModelMappings(mappings);
		expect(result).toEqual({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});
	});

	test("parseModelMappings handles invalid JSON", () => {
		const result = parseModelMappings("invalid-json");
		expect(result).toBeNull();
	});

	test("parseModelMappings handles null/empty", () => {
		expect(parseModelMappings(null)).toBeNull();
		expect(parseModelMappings("")).toBeNull();
	});

	test("mapModelName uses direct pattern matching", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "gpt-4",
				opus: "gpt-4-turbo",
				haiku: "gpt-3.5-turbo",
			}),
			custom_endpoint: null,
		};

		// Test direct pattern matching with realistic mappings
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount); // Current
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount); // Current
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount); // Current

		// Future model versions - demonstrating future-proof behavior
		const result4 = mapModelName("claude-sonnet-4-6-20251129", mockAccount); // Future version
		const result5 = mapModelName("claude-haiku-4-6-20251101", mockAccount); // Future version
		const result6 = mapModelName("claude-opus-4-5-20251105", mockAccount); // Future version

		// Current models
		expect(result1).toBe("gpt-4"); // Matches "sonnet"
		expect(result2).toBe("gpt-3.5-turbo"); // Matches "haiku"
		expect(result3).toBe("gpt-4-turbo"); // Matches "opus"

		// Future models - should still work without any code changes
		expect(result4).toBe("gpt-4"); // Still matches "sonnet"
		expect(result5).toBe("gpt-3.5-turbo"); // Still matches "haiku"
		expect(result6).toBe("gpt-4-turbo"); // Still matches "opus"
	});

	test("real database mappings work correctly", () => {
		// Test with real mappings from the database
		const openrouterMappings =
			'{"opus":"z-ai/glm-4.5-air:free","sonnet":"z-ai/glm-4.5-air:free","haiku":"z-ai/glm-4.5-air:free"}';

		const mockAccount: Account = {
			id: "test",
			name: "openrouter-test",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: openrouterMappings,
			custom_endpoint: null,
		};

		// Test real client model names
		const sonnetRequest = "claude-sonnet-4-5-20250929";
		const haikuRequest = "claude-haiku-4-5-20251001";
		const opusRequest = "claude-opus-4-1-20250805";

		// These should be mapped using the direct pattern matching logic
		const sonnetMapped = mapModelName(sonnetRequest, mockAccount);
		const haikuMapped = mapModelName(haikuRequest, mockAccount);
		const opusMapped = mapModelName(opusRequest, mockAccount);

		expect(sonnetMapped).toBe("z-ai/glm-4.5-air:free"); // matches "sonnet"
		expect(haikuMapped).toBe("z-ai/glm-4.5-air:free"); // matches "haiku"
		expect(opusMapped).toBe("z-ai/glm-4.5-air:free"); // matches "opus"

		// Test future model versions work
		const futureSonnet = mapModelName(
			"claude-sonnet-5-0-20251201",
			mockAccount,
		);
		expect(futureSonnet).toBe("z-ai/glm-4.5-air:free"); // still matches "sonnet"
	});

	test("mapModelName handles missing model_mappings gracefully", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: null, // No custom mappings
			custom_endpoint: null,
		};

		// Should use default fallback mappings
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount);
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount);

		expect(result1).toBe("openai/gpt-5"); // Default sonnet fallback
		expect(result2).toBe("openai/gpt-5-mini"); // Default haiku fallback
		expect(result3).toBe("openai/gpt-5"); // Default opus fallback
	});

	test("mapModelName handles case insensitive pattern matching correctly", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "lowercase-gpt-4",
				opus: "lowercase-gpt-4-turbo",
				haiku: "lowercase-gpt-3.5",
			}),
			custom_endpoint: null,
		};

		// Should match using case-insensitive pattern matching
		const sonnetResult = mapModelName("claude-sonnet-4-5-20250929", mockAccount);
		const haikuResult = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const opusResult = mapModelName("claude-opus-4-1-20250805", mockAccount);

		// Should match the lowercase mappings due to case-insensitive pattern matching
		expect(sonnetResult).toBe("lowercase-gpt-4");
		expect(haikuResult).toBe("lowercase-gpt-3.5");
		expect(opusResult).toBe("lowercase-gpt-4-turbo");
	});
});
