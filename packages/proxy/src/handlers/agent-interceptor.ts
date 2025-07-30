import { agentRegistry } from "@ccflare/agents";
import type { DatabaseOperations } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
import type { Agent } from "@ccflare/types";

const log = new Logger("AgentInterceptor");

export interface AgentInterceptResult {
	modifiedBody: ArrayBuffer | null;
	agentUsed: string | null;
	originalModel: string | null;
	appliedModel: string | null;
}

/**
 * Detects agent usage and modifies the request body to use the preferred model
 * @param requestBodyBuffer - The buffered request body
 * @param dbOps - Database operations instance
 * @returns Modified request body and agent detection information
 */
export async function interceptAndModifyRequest(
	requestBodyBuffer: ArrayBuffer | null,
	dbOps: DatabaseOperations,
): Promise<AgentInterceptResult> {
	// If no body, nothing to intercept
	if (!requestBodyBuffer) {
		return {
			modifiedBody: null,
			agentUsed: null,
			originalModel: null,
			appliedModel: null,
		};
	}

	try {
		// Parse the request body
		const bodyText = new TextDecoder().decode(requestBodyBuffer);
		const requestBody = JSON.parse(bodyText);

		// Extract original model
		const originalModel = requestBody.model || null;

		// Extract system prompt to detect agent usage
		const systemPrompt = extractSystemPrompt(requestBody);
		if (!systemPrompt) {
			// No system prompt, no agent detection possible
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: null,
				originalModel,
				appliedModel: originalModel,
			};
		}

		// Detect agent usage
		const agents = await agentRegistry.getAgents();
		const detectedAgent = agents.find((agent: Agent) =>
			systemPrompt.includes(agent.systemPrompt.trim()),
		);

		if (!detectedAgent) {
			// No agent detected
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: null,
				originalModel,
				appliedModel: originalModel,
			};
		}

		log.info(
			`Detected agent usage: ${detectedAgent.name} (${detectedAgent.id})`,
		);

		// Look up model preference
		const preference = dbOps.getAgentPreference(detectedAgent.id);
		const preferredModel = preference?.model || detectedAgent.model;

		// If the preferred model is the same as original, no modification needed
		if (preferredModel === originalModel) {
			return {
				modifiedBody: requestBodyBuffer,
				agentUsed: detectedAgent.id,
				originalModel,
				appliedModel: originalModel,
			};
		}

		// Modify the request body with the preferred model
		log.info(`Modifying model from ${originalModel} to ${preferredModel}`);
		requestBody.model = preferredModel;

		// Convert back to buffer
		const modifiedBodyText = JSON.stringify(requestBody);
		const encodedData = new TextEncoder().encode(modifiedBodyText);
		// Create a new ArrayBuffer to ensure compatibility
		const modifiedBody = new ArrayBuffer(encodedData.byteLength);
		new Uint8Array(modifiedBody).set(encodedData);

		return {
			modifiedBody,
			agentUsed: detectedAgent.id,
			originalModel,
			appliedModel: preferredModel,
		};
	} catch (error) {
		log.error("Failed to intercept/modify request:", error);
		// On error, return original body unmodified
		return {
			modifiedBody: requestBodyBuffer,
			agentUsed: null,
			originalModel: null,
			appliedModel: null,
		};
	}
}

interface MessageContent {
	type?: string;
	text?: string;
}

interface Message {
	role?: string;
	content?: string | MessageContent[];
}

interface SystemMessage {
	type: string;
	text: string;
	cache_control?: {
		type: string;
	};
}

interface RequestBody {
	messages?: Message[];
	model?: string;
	system?: string | SystemMessage[];
}

/**
 * Extracts system prompt from request body
 * @param requestBody - Parsed request body
 * @returns System prompt string or null
 */
function extractSystemPrompt(requestBody: RequestBody): string | null {
	// First check for system field at root level (Claude Code pattern)
	if (requestBody.system) {
		if (typeof requestBody.system === "string") {
			return requestBody.system;
		}
		if (Array.isArray(requestBody.system)) {
			// Concatenate all text from system messages
			return requestBody.system
				.filter(
					(item): item is SystemMessage => item.type === "text" && !!item.text,
				)
				.map((item) => item.text)
				.join("\n");
		}
	}

	// Then check messages array
	if (requestBody.messages && Array.isArray(requestBody.messages)) {
		// Look for system messages
		const systemMessage = requestBody.messages.find(
			(msg) => msg.role === "system",
		);

		if (systemMessage) {
			if (typeof systemMessage.content === "string") {
				return systemMessage.content;
			}
			if (Array.isArray(systemMessage.content)) {
				return systemMessage.content
					.filter(
						(item): item is MessageContent & { text: string } =>
							item.type === "text" && !!item.text,
					)
					.map((item) => item.text)
					.join("\n");
			}
		}

		// Also check for system prompt in user messages
		const userMessage = requestBody.messages.find((msg) => msg.role === "user");

		if (userMessage && Array.isArray(userMessage.content)) {
			// Concatenate all text content from the user message
			const allUserText = userMessage.content
				.filter(
					(item): item is MessageContent & { text: string } =>
						item.type === "text" && !!item.text,
				)
				.map((item) => item.text)
				.join("\n");

			// Return the full user text for agent detection
			return allUserText;
		} else if (userMessage && typeof userMessage.content === "string") {
			return userMessage.content;
		}
	}

	return null;
}
