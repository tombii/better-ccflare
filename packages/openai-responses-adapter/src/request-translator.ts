import { Logger } from "@better-ccflare/logger";
import type {
	AnthropicContent,
	AnthropicMessage,
	AnthropicRequest,
	AnthropicTool,
	AnthropicToolChoice,
	ResponseItem,
	ResponsesRequest,
	ResponsesTool,
} from "./types";

const logger = new Logger("openai-responses-adapter");

// Map OpenAI model names to Claude family aliases so per-account model_mappings
// (opus/sonnet/haiku) resolve correctly when Codex CLI requests reach the proxy.
// Rules based on OpenAI naming conventions:
//   *-pro   → opus  (heavy reasoning tier, $30+/M input)
//   *-mini  → haiku (fast/cheap tier)
//   *-nano  → haiku (fast/cheap tier)
//   gpt-5*  → sonnet (default capable tier, everything else)
// Non-gpt-5 names (e.g. gpt-4) are passed through unchanged.
function mapGptModelToClaudeFamily(model: string): string {
	const lower = model.toLowerCase();
	if (!lower.startsWith("gpt-")) return model;
	if (lower.endsWith("-pro")) return "claude-opus-4-5";
	if (lower.endsWith("-mini") || lower.endsWith("-nano"))
		return "claude-haiku-4-5";
	return "claude-sonnet-4-6";
}

function parseArguments(args: string): unknown {
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

function translateTools(tools: ResponsesTool[]): AnthropicTool[] {
	const result: AnthropicTool[] = [];
	for (const tool of tools) {
		if (tool.type !== "function") {
			logger.warn(`Skipping unsupported/built-in tool type: ${tool.type}`);
			continue;
		}
		result.push({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters ?? {},
		});
	}
	return result;
}

function translateToolChoice(
	choice: ResponsesRequest["tool_choice"],
): AnthropicToolChoice | undefined {
	if (choice === undefined) return undefined;
	if (choice === "auto") return { type: "auto" };
	if (choice === "required") return { type: "any" };
	if (choice === "none") return { type: "none" };
	if (typeof choice === "object" && choice.type === "function") {
		return { type: "tool", name: choice.name };
	}
	return undefined;
}

function translateContentItem(c: {
	type: string;
	text?: string;
	refusal?: string;
	image_url?: string;
	file_id?: string;
}): AnthropicContent {
	if (c.type === "input_text" || c.type === "output_text") {
		return { type: "text", text: c.text ?? "" };
	}

	if (c.type === "refusal") {
		return { type: "text", text: c.refusal ?? "" };
	}

	if (c.type === "input_image") {
		const imageUrl = c.image_url;
		if (typeof imageUrl === "string") {
			const trimmed = imageUrl.trim();
			const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(trimmed);
			if (dataUrlMatch) {
				return {
					type: "image",
					source: {
						type: "base64",
						media_type: dataUrlMatch[1],
						data: dataUrlMatch[2],
					},
				};
			}
			if (trimmed.length > 0) {
				return { type: "image", source: { type: "url", url: trimmed } };
			}
		}

		if (typeof c.file_id === "string" && c.file_id.length > 0) {
			return { type: "text", text: `[image file_id: ${c.file_id}]` };
		}

		return { type: "text", text: "[image content omitted]" };
	}

	logger.warn(`Unknown content type "${c.type}" — content dropped`);
	return { type: "text", text: "" };
}

function mergeConsecutiveSameRole(
	messages: AnthropicMessage[],
): AnthropicMessage[] {
	const merged: AnthropicMessage[] = [];
	for (const msg of messages) {
		const last = merged[merged.length - 1];
		if (last && last.role === msg.role) {
			last.content.push(...msg.content);
		} else {
			merged.push({ role: msg.role, content: [...msg.content] });
		}
	}
	return merged;
}

export function translateRequestToAnthropic(
	req: ResponsesRequest & { input: ResponseItem[] },
): AnthropicRequest {
	const messages: AnthropicMessage[] = [];
	const developerBlocks: string[] = [];

	for (const item of req.input) {
		if (item.type === "message") {
			const content: AnthropicContent[] = item.content.map((c) =>
				translateContentItem(c),
			);
			// developer role is used by Codex CLI for system-level instructions.
			// Anthropic /v1/messages does not accept this role in the messages array
			// so we extract the text and merge it into the system prompt instead.
			if ((item.role as string) === "developer") {
				for (const c of content) {
					if (c.type === "text") developerBlocks.push(c.text);
				}
				continue;
			}
			messages.push({ role: item.role, content });
			continue;
		}

		if (item.type === "function_call" || item.type === "custom_tool_call") {
			const toolUseBlock: AnthropicContent = {
				type: "tool_use",
				id: item.call_id,
				name: item.name,
				input: parseArguments(item.arguments),
			};
			const last = messages[messages.length - 1];
			if (last && last.role === "assistant") {
				last.content.push(toolUseBlock);
			} else {
				messages.push({ role: "assistant", content: [toolUseBlock] });
			}
			continue;
		}

		if (
			item.type === "function_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: item.call_id,
						content: item.output,
					},
				],
			});
		}
	}

	const mergedMessages = mergeConsecutiveSameRole(messages);

	const result: AnthropicRequest = {
		model: mapGptModelToClaudeFamily(req.model),
		messages: mergedMessages,
		max_tokens: req.max_output_tokens ?? 4096,
	};

	// Merge developer-role blocks and req.instructions into system prompt.
	const systemParts: string[] = [];
	if (developerBlocks.length > 0)
		systemParts.push(developerBlocks.join("\n\n"));
	if (req.instructions !== undefined) systemParts.push(req.instructions);
	if (systemParts.length > 0) result.system = systemParts.join("\n\n");

	if (req.stream !== undefined) {
		result.stream = req.stream;
	}

	const translatedTools =
		req.tools && req.tools.length > 0 ? translateTools(req.tools) : [];
	if (translatedTools.length > 0) {
		result.tools = translatedTools;
		const toolChoice = translateToolChoice(req.tool_choice);
		if (toolChoice !== undefined) {
			result.tool_choice = toolChoice;
		}
	}

	return result;
}
