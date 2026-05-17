import { Logger } from "@better-ccflare/logger";
import type {
	AnthropicContent,
	AnthropicMessage,
	AnthropicRequest,
	AnthropicTool,
	AnthropicToolChoice,
	ResponsesRequest,
	ResponsesTool,
} from "./types";

const logger = new Logger("openai-responses-adapter");

const BUILTIN_TOOL_TYPES = new Set([
	"web_search_preview",
	"code_interpreter",
	"file_search",
]);

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
		if (BUILTIN_TOOL_TYPES.has(tool.name)) {
			logger.warn(`Skipping built-in tool: ${tool.name}`);
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

	return { type: "text", text: c.refusal ?? "" };
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
	req: ResponsesRequest,
): AnthropicRequest {
	const messages: AnthropicMessage[] = [];

	for (const item of req.input) {
		if (item.type === "message") {
			const content: AnthropicContent[] = item.content.map((c) =>
				translateContentItem(c),
			);
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
		model: req.model,
		messages: mergedMessages,
		max_tokens: req.max_output_tokens ?? 8096,
	};

	if (req.instructions !== undefined) {
		result.system = req.instructions;
	}

	if (req.stream !== undefined) {
		result.stream = req.stream;
	}

	if (req.tools && req.tools.length > 0) {
		result.tools = translateTools(req.tools);
	}

	const toolChoice = translateToolChoice(req.tool_choice);
	if (toolChoice !== undefined) {
		result.tool_choice = toolChoice;
	}

	return result;
}
