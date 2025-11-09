import { describe, test, expect } from "bun:test";
import {
	getSortedMappingKeysForAccount,
	parseModelMappings,
	mapModelName
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";

describe("Model Mapping Caching", () => {
	test("getSortedMappingKeysForAccount returns cached results", () => {
		const mappings = JSON.stringify({
			"sonnet-4-5": "gpt-4",
			"sonnet-3-5": "gpt-3.5",
			"sonnet": "gpt-3.5-turbo",
			"opus": "gpt-4-turbo"
		});

		// First call - should compute and cache
		const keys1 = getSortedMappingKeysForAccount(mappings);
		// Sorted by length: "sonnet-4-5" (11), "sonnet-3-5" (11), "sonnet" (6), "opus" (4)
		expect(keys1).toEqual(["sonnet-4-5", "sonnet-3-5", "sonnet", "opus"]);

		// Second call - should return cached result
		const keys2 = getSortedMappingKeysForAccount(mappings);
		expect(keys2).toEqual(["sonnet-4-5", "sonnet-3-5", "sonnet", "opus"]);
	});

	test("real-world model mapping scenario", () => {
		// Test the actual scenario: client sends full model name, we match substrings
		const openrouterMappings = '{"sonnet":"z-ai/glm-4.5-air:free","haiku":"z-ai/glm-4.5-air:free","opus":"z-ai/glm-4.5-air:free"}';

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

		// These should be mapped using the substring matching logic
		const sonnetMapped = mapModelName(sonnetRequest, mockAccount);
		const haikuMapped = mapModelName(haikuRequest, mockAccount);
		const opusMapped = mapModelName(opusRequest, mockAccount);

		expect(sonnetMapped).toBe("z-ai/glm-4.5-air:free"); // matches "sonnet"
		expect(haikuMapped).toBe("z-ai/glm-4.5-air:free"); // matches "haiku"
		expect(opusMapped).toBe("z-ai/glm-4.5-air:free");  // matches "opus"

		// Test caching - second call should be faster
		const sonnetMapped2 = mapModelName(sonnetRequest, mockAccount);
		expect(sonnetMapped2).toBe("z-ai/glm-4.5-air:free");
	});

	test("getSortedMappingKeysForAccount handles identical mappings efficiently", () => {
		const mappings = JSON.stringify({
			"sonnet": "gpt-4",
			"opus": "gpt-4-turbo"
		});

		// Multiple accounts with same mappings should share cache
		const keys1 = getSortedMappingKeysForAccount(mappings);
		const keys2 = getSortedMappingKeysForAccount(mappings);
		const keys3 = getSortedMappingKeysForAccount(mappings);

		expect(keys1).toEqual(keys2);
		expect(keys2).toEqual(keys3);
		// Sorted by length: "sonnet" (6), "opus" (4)
		expect(keys1).toEqual(["sonnet", "opus"]);
	});

	test("getSortedMappingKeysForAccount handles different mappings separately", () => {
		const mappingsA = JSON.stringify({ "claude-3-5-sonnet": "gpt-4" });
		const mappingsB = JSON.stringify({ "claude-3-5-sonnet": "z-ai/gpt-4" });

		const keysA = getSortedMappingKeysForAccount(mappingsA);
		const keysB = getSortedMappingKeysForAccount(mappingsB);

		expect(keysA).toEqual(["claude-3-5-sonnet"]);
		expect(keysB).toEqual(["claude-3-5-sonnet"]);
		// Note: These will be the same array content but different cache entries internally
	});

	test("mapModelName uses cached sorting", () => {
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
				"claude-sonnet": "gpt-4",
				"sonnet": "gpt-3.5-turbo"
			}),
			custom_endpoint: null,
		};

		// This should use the cached sorting internally
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount);
		const result2 = mapModelName("random-sonnet-model", mockAccount);

		expect(result1).toBe("gpt-4"); // Exact match
		expect(result2).toBe("gpt-3.5-turbo"); // Wildcard match using cached sorting
	});

	test("real database mappings work with caching", () => {
		// Test with real mappings from the database
		const openrouterMappings = '{"opus":"z-ai/glm-4.5-air:free","sonnet":"z-ai/glm-4.5-air:free","haiku":"z-ai/glm-4.5-air:free"}';
		const litellmMappings = '{"opus":"qwen3-coder-plus","sonnet":"qwen3-coder-plus","haiku":"qwen3-coder-flash"}';
		const nanogptMappings = '{"opus":"zai-org/GLM-4.5-FP8","sonnet":"zai-org/GLM-4.5-FP8","haiku":"zai-org/GLM-4.5-Air"}';

		// Test that all these real mappings work
		// Keys are sorted by length: "sonnet" (6), "haiku" (5), "opus" (4)
		const openrouterKeys = getSortedMappingKeysForAccount(openrouterMappings);
		const litellmKeys = getSortedMappingKeysForAccount(litellmMappings);
		const nanogptKeys = getSortedMappingKeysForAccount(nanogptMappings);

		expect(openrouterKeys).toEqual(["sonnet", "haiku", "opus"]);
		expect(litellmKeys).toEqual(["sonnet", "haiku", "opus"]);
		expect(nanogptKeys).toEqual(["sonnet", "haiku", "opus"]);

		// Test caching by calling again - should return same results
		const openrouterKeys2 = getSortedMappingKeysForAccount(openrouterMappings);
		expect(openrouterKeys).toEqual(openrouterKeys2);
	});

	test("getSortedMappingKeysForAccount handles edge cases", () => {
		expect(getSortedMappingKeysForAccount(null)).toEqual([]);
		expect(getSortedMappingKeysForAccount("")).toEqual([]);
		expect(getSortedMappingKeysForAccount("invalid-json")).toEqual([]);
	});
});