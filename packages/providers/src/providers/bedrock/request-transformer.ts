import type {
	ConverseStreamCommandInput,
	Message,
} from "@aws-sdk/client-bedrock-runtime";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockRequestTransformer");

/**
 * Claude Messages API request format
 */
export interface ClaudeRequest {
	model: string;
	messages: Array<{
		role: string;
		content: string | Array<{ type: string; text?: string }>;
	}>;
	max_tokens: number;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[];
	system?: string | Array<{ type: string; text: string }>;
	metadata?: unknown;
	stream?: boolean;
}

/**
 * Bedrock Converse API input (without modelId)
 * modelId is added separately in the provider after translation
 */
export interface BedrockConverseInput {
	messages?: Message[];
	system?: Array<{ text: string }>;
	inferenceConfig?: {
		maxTokens?: number;
		temperature?: number;
		topP?: number;
		stopSequences?: string[];
	};
}

/**
 * Transform Claude Messages API request to Bedrock Converse API format
 *
 * Field mappings:
 * - messages → messages (requires content transformation)
 * - model → NOT in ConverseCommandInput (model specified separately in invokeModel())
 * - max_tokens → inferenceConfig.maxTokens
 * - temperature → inferenceConfig.temperature
 * - top_p → inferenceConfig.topP
 * - stop_sequences → inferenceConfig.stopSequences
 * - system → system (array format: [{ text: string }])
 *
 * Unsupported parameters (stripped with warnings):
 * - top_k - Bedrock doesn't support
 * - metadata - Not supported
 * - stream - Handled separately, not in transformation
 *
 * @param claudeRequest - Claude Messages API request
 * @returns Bedrock Converse API input (modelId added separately)
 */
export function transformMessagesRequest(
	claudeRequest: ClaudeRequest,
): BedrockConverseInput {
	// Warn about unsupported parameters
	if (claudeRequest.top_k) {
		log.warn("Bedrock does not support top_k parameter, stripping");
	}
	if (claudeRequest.metadata) {
		log.warn("Bedrock does not support metadata parameter, stripping");
	}

	// Transform system prompt to Bedrock format
	let systemPrompt: Array<{ text: string }> | undefined;
	if (claudeRequest.system) {
		if (typeof claudeRequest.system === "string") {
			systemPrompt = [{ text: claudeRequest.system }];
		} else {
			systemPrompt = claudeRequest.system.map((item) => ({
				text: item.text,
			}));
		}
	}

	// Transform messages to Bedrock format
	// Bedrock requires content to be an array of { text: string } objects
	const transformedMessages: Message[] = [];
	for (const [index, msg] of claudeRequest.messages.entries()) {
		let content: Array<{ text: string }> = [];

		if (typeof msg.content === "string") {
			// Simple string content
			const text = msg.content.trim();
			if (text.length > 0) {
				content = [{ text }];
			}
		} else if (Array.isArray(msg.content)) {
			// Array of content blocks - extract non-empty text blocks only
			content = msg.content
				.filter(
					(block) =>
						block.type === "text" &&
						typeof block.text === "string" &&
						block.text.trim().length > 0,
				)
				.map((block) => ({ text: block.text!.trim() }));
		} else {
			log.warn(
				`Unexpected message content type at index ${index}: ${typeof msg.content}, dropping message`,
			);
		}

		// Bedrock rejects messages with empty content arrays.
		// Skip empty messages to avoid ValidationException.
		if (content.length === 0) {
			log.warn(
				`Dropping empty message at index ${index} (role: ${msg.role}) before Bedrock transform`,
			);
			continue;
		}

		transformedMessages.push({
			role: msg.role,
			content,
		} as Message);
	}

	if (transformedMessages.length === 0) {
		throw new Error(
			"All messages were empty or contained only non-text content and were dropped. Bedrock requires at least one non-empty message.",
		);
	}

	return {
		messages: transformedMessages,
		system: systemPrompt,
		inferenceConfig: {
			maxTokens: claudeRequest.max_tokens,
			temperature: claudeRequest.temperature,
			topP: claudeRequest.top_p,
			stopSequences: claudeRequest.stop_sequences,
		},
	};
}

/**
 * Detect if request is streaming based on stream parameter in body
 *
 * Per CONTEXT.md decision: "Detection method: Client stream parameter in request body (not headers)"
 * Default: false (non-streaming) when parameter missing
 *
 * @param request - Request object
 * @returns true if streaming mode requested
 */
export async function detectStreamingMode(request: Request): Promise<boolean> {
	try {
		const bodyText = await request.text();
		const body = JSON.parse(bodyText) as { stream?: boolean };
		return body.stream === true; // Default to false if missing
	} catch (error) {
		log.warn(
			`Failed to parse request body for streaming detection: ${(error as Error).message}`,
		);
		return false; // Default to non-streaming on error
	}
}

/**
 * Transform Claude Messages API request to Bedrock ConverseStream API format
 *
 * ConverseStreamCommandInput has the same structure as ConverseCommandInput:
 * - messages
 * - system
 * - inferenceConfig (maxTokens, temperature, topP, stopSequences)
 *
 * The only difference is the command used (ConverseStreamCommand vs ConverseCommand).
 *
 * @param claudeRequest - Claude Messages API request
 * @returns Bedrock ConverseStream API input (modelId added separately)
 */
export function transformStreamingRequest(
	claudeRequest: ClaudeRequest,
): ConverseStreamCommandInput {
	// Bedrock uses same input format for streaming and non-streaming
	// Reuse the existing transformation logic
	const nonStreamingInput = transformMessagesRequest(claudeRequest);

	// ConverseStreamCommandInput has same structure as ConverseCommandInput
	// Cast is safe because fields are identical
	return nonStreamingInput as ConverseStreamCommandInput;
}

/**
 * Check if a model supports streaming
 *
 * Heuristic for determining if model supports streaming:
 * - All Anthropic Claude models support streaming
 * - Check if modelId contains "anthropic" or "claude"
 * - Default to true (attempt streaming, fall back on error)
 *
 * @param modelId - Model identifier
 * @returns true if model likely supports streaming
 */
export function supportsStreaming(modelId: string): boolean {
	// All Claude models support streaming
	if (modelId.includes("anthropic") || modelId.includes("claude")) {
		return true;
	}
	// Default to true, will fall back on error
	return true;
}
