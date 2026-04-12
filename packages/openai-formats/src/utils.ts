import { Logger } from "@better-ccflare/logger";

const _log = new Logger("openai-formats/utils");

/**
 * Attempt to repair truncated tool-call JSON that was cut off mid-stream.
 * Mirrors the recovery logic in qwen-code's StreamingToolCallParser.
 * Returns the repair delta to emit (empty string if no repair needed/possible).
 */
export function repairTruncatedToolJson(accumulated: string): string {
	if (!accumulated.trim()) return "";
	try {
		JSON.parse(accumulated);
		return ""; // already valid
	} catch {
		// Try suffixes in order of likelihood
		for (const suffix of ['"}', "}", '"', '"}}']) {
			try {
				JSON.parse(`${accumulated}${suffix}`);
				return suffix;
			} catch {
				// try next
			}
		}
		return ""; // unrecoverable
	}
}

/**
 * Helper to remove format: 'uri' from JSON schemas (some providers reject it)
 */
export function removeUriFormat(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map((item) => removeUriFormat(item));
	}

	if (schema === null || typeof schema !== "object") {
		return schema;
	}

	const obj = schema as Record<string, unknown>;

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		// Strip $schema — not supported by OpenAI-compatible tool calling spec
		if (key === "$schema") continue;
		// Strip format: uri from string fields
		if (key === "format" && obj.type === "string" && obj[key] === "uri")
			continue;
		result[key] = removeUriFormat(obj[key]);
	}
	return result;
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 */
export function mapOpenAIFinishReason(openaiReason?: string): string {
	switch (openaiReason) {
		case "stop":
			return "end_turn";
		case "length":
			return "max_tokens";
		case "function_call":
		case "tool_calls":
			return "tool_use";
		case "content_filter":
			return "stop_sequence";
		default:
			return "end_turn";
	}
}

/**
 * Convert Anthropic API paths to OpenAI-compatible paths
 */
export function convertAnthropicPathToOpenAI(anthropicPath: string): string {
	// Anthropic /v1/messages → OpenAI /v1/chat/completions
	if (anthropicPath === "/v1/messages") {
		return "/v1/chat/completions";
	}

	// For other paths, keep them as-is for now
	// This could be expanded based on needs
	return anthropicPath;
}
