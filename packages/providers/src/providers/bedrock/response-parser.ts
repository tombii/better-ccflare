import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockResponseParser");

/**
 * Bedrock Converse API response structure
 *
 * This represents the raw response from Bedrock's Converse API.
 * Phase 4 transforms this to Claude Messages API format for client compatibility.
 */
export interface BedrockConverseResponse {
	output: {
		message: {
			role: string;
			content: Array<{ type: string; text?: string; [key: string]: unknown }>;
		};
	};
	stopReason: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadInputTokens?: number;
		cacheWriteInputTokens?: number;
	};
	model?: string;
}

/**
 * Transform Bedrock Converse response to Claude Messages API format
 *
 * Converts raw Bedrock JSON response to strict Claude Messages API compatibility.
 * This transformation enables clients to consume Bedrock responses identically
 * to native Claude API responses.
 *
 * Transformation mapping:
 * - output.message.content → content (1:1 array mapping, preserves text and tool blocks)
 * - stopReason → stop_reason
 * - usage.inputTokens → usage.input_tokens
 * - usage.outputTokens → usage.output_tokens
 * - AWS-specific metadata dropped entirely (no additionalModelResponseFields, metrics.latencyMs)
 *
 * Error handling:
 * - Falls back to original response on transformation errors (graceful degradation)
 * - Logs transformation errors for debugging
 * - Clones response to preserve body for retry/logging
 *
 * @param response - Bedrock Converse API response (application/json)
 * @returns Response with Claude Messages API format body
 *
 * Example input (Bedrock):
 * ```json
 * {
 *   "output": {
 *     "message": {
 *       "role": "assistant",
 *       "content": [{ "type": "text", "text": "Hello" }]
 *     }
 *   },
 *   "stopReason": "end_turn",
 *   "usage": { "inputTokens": 10, "outputTokens": 5 }
 * }
 * ```
 *
 * Example output (Claude):
 * ```json
 * {
 *   "id": "msg_1770381324000",
 *   "type": "message",
 *   "role": "assistant",
 *   "content": [{ "type": "text", "text": "Hello" }],
 *   "model": "claude-3-5-sonnet-20241022",
 *   "stop_reason": "end_turn",
 *   "usage": { "input_tokens": 10, "output_tokens": 5 }
 * }
 * ```
 */
export async function transformNonStreamingResponse(
	response: Response,
): Promise<Response> {
	try {
		// Clone response to avoid consuming body (preserves for retry/logging)
		const clone = response.clone();
		const json = (await clone.json()) as BedrockConverseResponse;

		// Extract fields from Bedrock format
		const content = json.output?.message?.content || [];
		const stopReason = json.stopReason;
		const usage = json.usage;

		// Transform to Claude Messages API format
		const claudeResponse = {
			id: `msg_${Date.now()}`, // Generate unique ID
			type: "message",
			role: "assistant",
			content: content, // 1:1 mapping, preserve as-is
			model: json.model || "claude-3-5-sonnet-20241022", // Preserve or default
			stop_reason: stopReason,
			usage: usage
				? {
						input_tokens: usage.inputTokens,
						output_tokens: usage.outputTokens,
					}
				: undefined,
		};

		// Return new Response with transformed JSON body
		return new Response(JSON.stringify(claudeResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		// Graceful degradation: return original response on transformation error
		log.error(
			`Failed to transform Bedrock response: ${(error as Error).message}`,
		);
		return response;
	}
}
