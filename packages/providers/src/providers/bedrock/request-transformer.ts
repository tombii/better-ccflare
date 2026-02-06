import type { Message } from "@aws-sdk/client-bedrock-runtime";
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
 * - messages → messages (direct mapping, same structure)
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

	return {
		messages: claudeRequest.messages as Message[],
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
export async function detectStreamingMode(
	request: Request,
): Promise<boolean> {
	try {
		const bodyText = await request.text();
		const body = JSON.parse(bodyText) as { stream?: boolean };
		return body.stream === true; // Default to false if missing
	} catch (error) {
		log.warn(`Failed to parse request body for streaming detection: ${(error as Error).message}`);
		return false; // Default to non-streaming on error
	}
}
