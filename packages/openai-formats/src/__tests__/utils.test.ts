import { describe, expect, it } from "bun:test";
import {
	convertAnthropicPathToOpenAI,
	mapOpenAIFinishReason,
	repairTruncatedToolJson,
	sanitizeSchemaForOpenAI,
} from "../utils";

// ── repairTruncatedToolJson ───────────────────────────────────────────────────

describe("repairTruncatedToolJson", () => {
	it("returns empty string for already-valid JSON", () => {
		expect(repairTruncatedToolJson('{"key":"value"}')).toBe("");
	});

	it("repairs a JSON string missing closing quote and brace", () => {
		const suffix = repairTruncatedToolJson('{"key":"val');
		const repaired = `{"key":"val${suffix}`;
		expect(() => JSON.parse(repaired)).not.toThrow();
	});

	it("repairs JSON missing only the closing brace", () => {
		const suffix = repairTruncatedToolJson('{"key":"value"');
		const repaired = `{"key":"value"${suffix}`;
		expect(() => JSON.parse(repaired)).not.toThrow();
	});

	it("returns empty string for an empty or whitespace-only string", () => {
		expect(repairTruncatedToolJson("")).toBe("");
		expect(repairTruncatedToolJson("   ")).toBe("");
	});

	it("returns empty string when repair is not possible", () => {
		// Deeply corrupt JSON that no suffix can fix
		expect(repairTruncatedToolJson("{{{[[[")).toBe("");
	});

	it("returns empty string for valid array JSON", () => {
		expect(repairTruncatedToolJson("[1, 2, 3]")).toBe("");
	});
});

// ── sanitizeSchemaForOpenAI ───────────────────────────────────────────────────

describe("sanitizeSchemaForOpenAI", () => {
	it("strips format:uri from string-type properties", () => {
		const input = { type: "string", format: "uri" };
		const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
		expect(result).not.toHaveProperty("format");
		expect(result.type).toBe("string");
	});

	it("preserves non-uri format values", () => {
		const input = { type: "string", format: "date-time" };
		const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
		expect(result.format).toBe("date-time");
	});

	it("strips $schema key", () => {
		const input = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
		};
		const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
		expect(result).not.toHaveProperty("$schema");
	});

	it("recurses into nested objects", () => {
		const input = {
			type: "object",
			properties: {
				url: { type: "string", format: "uri" },
				name: { type: "string", format: "date-time" },
			},
		};
		const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		expect(props?.url).not.toHaveProperty("format");
		expect(props?.name?.format).toBe("date-time");
	});

	it("recurses into arrays", () => {
		const input = [
			{ type: "string", format: "uri" },
			{ type: "string", format: "email" },
		];
		const result = sanitizeSchemaForOpenAI(input) as Array<
			Record<string, unknown>
		>;
		expect(result[0]).not.toHaveProperty("format");
		expect(result[1]?.format).toBe("email");
	});

	it("passes through null", () => {
		expect(sanitizeSchemaForOpenAI(null)).toBeNull();
	});

	it("passes through primitives unchanged", () => {
		expect(sanitizeSchemaForOpenAI("string")).toBe("string");
		expect(sanitizeSchemaForOpenAI(42)).toBe(42);
		expect(sanitizeSchemaForOpenAI(true)).toBe(true);
	});

	it("does not strip format from non-string types", () => {
		const input = { type: "integer", format: "int64" };
		const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
		// format:uri stripping only applies to string types
		expect(result.format).toBe("int64");
	});

	it("strips pattern containing a negative lookahead", () => {
		const input = {
			type: "object",
			properties: {
				to: {
					type: "array",
					items: {
						type: "string",
						pattern:
							"^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
					},
				},
			},
		};
		const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		const items = props?.to?.items as Record<string, unknown>;
		expect(items).not.toHaveProperty("pattern");
		expect(items.type).toBe("string");
	});

	it("strips patterns with each lookaround flavor", () => {
		for (const pattern of ["foo(?=bar)", "(?<=a)b", "(?<!a)b"]) {
			const input = { type: "string", pattern };
			const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
			expect(result).not.toHaveProperty("pattern");
			expect(result.type).toBe("string");
		}
	});

	it("preserves plain patterns without lookaround", () => {
		const simple = sanitizeSchemaForOpenAI({
			type: "string",
			pattern: "^[a-z]+$",
		}) as Record<string, unknown>;
		expect(simple.pattern).toBe("^[a-z]+$");

		const grouped = sanitizeSchemaForOpenAI({
			type: "string",
			pattern: "^(abc|def)$",
		}) as Record<string, unknown>;
		expect(grouped.pattern).toBe("^(abc|def)$");
	});

	it("does not strip a non-string pattern value", () => {
		const input = { type: "object", pattern: 123 };
		const result = sanitizeSchemaForOpenAI(input) as Record<string, unknown>;
		expect(result.pattern).toBe(123);
	});
});

// ── mapOpenAIFinishReason ─────────────────────────────────────────────────────

describe("mapOpenAIFinishReason", () => {
	it("maps stop → end_turn", () => {
		expect(mapOpenAIFinishReason("stop")).toBe("end_turn");
	});

	it("maps length → max_tokens", () => {
		expect(mapOpenAIFinishReason("length")).toBe("max_tokens");
	});

	it("maps tool_calls → tool_use", () => {
		expect(mapOpenAIFinishReason("tool_calls")).toBe("tool_use");
	});

	it("maps function_call → tool_use", () => {
		expect(mapOpenAIFinishReason("function_call")).toBe("tool_use");
	});

	it("maps content_filter → end_turn", () => {
		expect(mapOpenAIFinishReason("content_filter")).toBe("end_turn");
	});

	it("defaults unknown values to end_turn", () => {
		expect(mapOpenAIFinishReason("unknown_reason")).toBe("end_turn");
		expect(mapOpenAIFinishReason(undefined)).toBe("end_turn");
	});
});

// ── convertAnthropicPathToOpenAI ──────────────────────────────────────────────

describe("convertAnthropicPathToOpenAI", () => {
	it("converts /v1/messages to /v1/chat/completions", () => {
		expect(convertAnthropicPathToOpenAI("/v1/messages")).toBe(
			"/v1/chat/completions",
		);
	});

	it("passes through unknown paths unchanged", () => {
		expect(convertAnthropicPathToOpenAI("/v1/models")).toBe("/v1/models");
		expect(convertAnthropicPathToOpenAI("/v1/embeddings")).toBe(
			"/v1/embeddings",
		);
	});
});
