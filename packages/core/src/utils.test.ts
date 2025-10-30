import { describe, expect, it } from "bun:test";
import { levenshteinDistance } from "@better-ccflare/core";

describe("Levenshtein Distance Utility", () => {
	it("should return 0 for identical strings", () => {
		expect(levenshteinDistance("hello", "hello")).toBe(0);
		expect(levenshteinDistance("", "")).toBe(0);
		expect(levenshteinDistance("test", "test")).toBe(0);
	});

	it("should return length of one string when the other is empty", () => {
		expect(levenshteinDistance("hello", "")).toBe(5);
		expect(levenshteinDistance("", "world")).toBe(5);
		expect(levenshteinDistance("a", "")).toBe(1);
		expect(levenshteinDistance("", "a")).toBe(1);
	});

	it("should calculate distance for simple edits", () => {
		// Single character substitution
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);

		// Single character difference
		expect(levenshteinDistance("cat", "bat")).toBe(1);
		expect(levenshteinDistance("hello", "hallo")).toBe(1);

		// Single character insertion/deletion
		expect(levenshteinDistance("cat", "cats")).toBe(1);
		expect(levenshteinDistance("cats", "cat")).toBe(1);
		expect(levenshteinDistance("cat", "at")).toBe(1);
		expect(levenshteinDistance("at", "cat")).toBe(1);
	});

	it("should handle case-sensitive comparisons", () => {
		expect(levenshteinDistance("Hello", "hello")).toBe(1); // Different case
		expect(levenshteinDistance("TEST", "test")).toBe(4); // All different case
		expect(levenshteinDistance("Test", "test")).toBe(1); // First character different case
	});

	it("should work with special characters and numbers", () => {
		expect(levenshteinDistance("test123", "test456")).toBe(3);
		expect(levenshteinDistance("hello!", "hello?")).toBe(1);
		expect(levenshteinDistance("test@domain.com", "test@domain.org")).toBe(3);
		expect(levenshteinDistance("a b c", "a-c")).toBe(3); // spaces vs dash and deletions
	});

	it("should return correct distance for completely different strings", () => {
		expect(levenshteinDistance("abc", "xyz")).toBe(3);
		expect(levenshteinDistance("short", "verylongstring")).toBe(12); // all chars different + length diff
	});

	it("should handle longer strings correctly", () => {
		const str1 = "this is a longer test string with multiple words";
		const str2 = "this is a longer test string with multiple word";
		expect(levenshteinDistance(str1, str2)).toBe(1); // One character difference (missing 's')

		const str3 = "the quick brown fox jumps over the lazy dog";
		const str4 = "the quick brown cat jumps over the lazy dog";
		expect(levenshteinDistance(str3, str4)).toBe(3); // "fox" -> "cat" = 3 character changes
	});

	it("should be symmetric (distance from a to b equals distance from b to a)", () => {
		const str1 = "algorithm";
		const str2 = "logarithm";
		const dist1 = levenshteinDistance(str1, str2);
		const dist2 = levenshteinDistance(str2, str1);
		expect(dist1).toBe(dist2);
		expect(dist1).toBe(3); // "alg" vs "log" = 2 changes, "m" vs "" = 1 deletion
	});
});

describe("Levenshtein Distance in CLI Context", () => {
	it("should work for CLI mode suggestions", () => {
		// Test typical CLI command scenarios
		expect(levenshteinDistance("claude-oauth", "claude-oaut")).toBe(1); // Simple typo
		expect(levenshteinDistance("console", "consle")).toBe(1); // Missing character
		expect(levenshteinDistance("zai", "z.ai")).toBe(1); // Extra character
		expect(levenshteinDistance("openai-compatible", "openai-compat")).toBe(4); // Missing characters
	});

	it("should detect typos within threshold for CLI suggestions", () => {
		// Simulate the CLI's typo detection (threshold of 2)
		const _validModes = [
			"claude-oauth",
			"console",
			"zai",
			"minimax",
			"openai-compatible",
		];

		// Test cases that should be within the 2-character threshold
		expect(
			levenshteinDistance("claude-oauth", "claude-oaut"),
		).toBeLessThanOrEqual(2);
		expect(levenshteinDistance("console", "consle")).toBeLessThanOrEqual(2);
		expect(levenshteinDistance("zai", "azi")).toBeLessThanOrEqual(2);

		// Test cases that should be outside the threshold
		expect(levenshteinDistance("claude-oauth", "xyz")).toBeGreaterThan(2);
	});
});
