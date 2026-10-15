import {
	LATEST_HAIKU_MODEL,
	LATEST_OPUS_MODEL,
	LATEST_SONNET_MODEL,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { getRequestTools, getTranslatedToolName } from "./custom-tools";
import { asText } from "./sanitize";
import type {
	AnthropicContent,
	AnthropicImageContent,
	AnthropicMessage,
	AnthropicRequest,
	AnthropicTextContent,
	AnthropicTool,
	AnthropicToolChoice,
	ResponseItem,
	ResponsesRequest,
	ResponsesTool,
} from "./types";

const logger = new Logger("openai-responses-adapter");

// A single malformed request can carry thousands of bad items, and dropping
// each one silently would hide the client-integration bug that caused it. Cap
// the warnings per request so one payload cannot flood the log, and report the
// remainder as a single count once translation finishes.
const MAX_TRANSLATION_WARNS = 5;

interface TranslationWarnings {
	warn(message: string): void;
	flush(): void;
}

function createTranslationWarnings(): TranslationWarnings {
	let emitted = 0;
	let suppressed = 0;
	return {
		warn(message: string): void {
			if (emitted < MAX_TRANSLATION_WARNS) {
				emitted++;
				logger.warn(message);
			} else {
				suppressed++;
			}
		},
		flush(): void {
			if (suppressed > 0) {
				logger.warn(`${suppressed} further translation warning(s) suppressed`);
			}
		},
	};
}

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
	if (lower.endsWith("-pro")) return LATEST_OPUS_MODEL;
	if (lower.endsWith("-mini") || lower.endsWith("-nano"))
		return LATEST_HAIKU_MODEL;
	return LATEST_SONNET_MODEL;
}

function parseArguments(args: string): unknown {
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

function translateTools(
	tools: ResponsesTool[],
	warnings: TranslationWarnings,
): AnthropicTool[] {
	const result: AnthropicTool[] = [];
	for (const tool of tools) {
		// Branching stays on `tool.type` so the union still narrows; only the
		// text-producing sites use asText(). A strict `===` never coerces, so a
		// non-string `type` simply fails to match.
		if (tool.type === "custom") {
			// `tool.description` and the grammar fields are joined into the
			// description below, so a non-string must be dropped rather than
			// coerced — an object with a null `toString` throws on `.join()`.
			const grammar =
				tool.format?.type === "grammar"
					? `The input must follow this ${asText(tool.format.syntax) ?? ""} grammar:\n${asText(tool.format.definition) ?? ""}`
					: undefined;
			const description = [
				asText(tool.description),
				"Pass the tool's complete raw text in the input string.",
				grammar,
			]
				.filter(Boolean)
				.join("\n\n");
			result.push({
				name: getTranslatedToolName(tool.name, tool.namespace),
				description,
				input_schema: {
					type: "object",
					properties: { input: { type: "string" } },
					required: ["input"],
					additionalProperties: false,
				},
			});
			continue;
		}
		if (tool.type !== "function") {
			// Reached with a non-string `type` too, which must not be
			// interpolated into the warning below.
			const toolType = asText(tool.type);
			warnings.warn(
				toolType === undefined
					? "Skipping tool declaration with a non-string type"
					: `Skipping unsupported/built-in tool type: ${toolType}`,
			);
			continue;
		}
		result.push({
			name: getTranslatedToolName(tool.name, tool.namespace),
			description: asText(tool.description),
			input_schema: tool.parameters ?? {},
		});
	}
	return result;
}

function translateToolChoice(
	choice: ResponsesRequest["tool_choice"],
): AnthropicToolChoice | undefined {
	if (choice === undefined || choice === null) return undefined;
	if (choice === "auto") return { type: "auto" };
	if (choice === "required") return { type: "any" };
	if (choice === "none") return { type: "none" };
	if (
		typeof choice === "object" &&
		!Array.isArray(choice) &&
		(choice.type === "function" || choice.type === "custom")
	) {
		return {
			type: "tool",
			name: getTranslatedToolName(choice.name, choice.namespace),
		};
	}
	return undefined;
}

function translateContentItem(
	c: {
		type: string;
		text?: string;
		refusal?: string;
		image_url?: string;
		file_id?: string;
	},
	warnings: TranslationWarnings,
): AnthropicTextContent | AnthropicImageContent {
	// Parts come from untrusted client JSON and are not guaranteed to be plain
	// objects; reading `.type` off a null, primitive or array part would throw
	// out of the handler. Fall back to empty text, as the unknown-type path
	// below does.
	if (c === null || typeof c !== "object" || Array.isArray(c)) {
		return { type: "text", text: "" };
	}

	// A present-but-non-string `type` matches no branch, so it must not be
	// interpolated into the warning below — an object with a null `toString`
	// throws when the template literal coerces it.
	const contentType = asText(c.type);

	if (contentType === "input_text" || contentType === "output_text") {
		// `text` is forwarded as text, so a non-string must degrade to empty
		// rather than being coerced (which could throw, or leak "[object
		// Object]" into the prompt).
		return { type: "text", text: asText(c.text) ?? "" };
	}

	if (contentType === "refusal") {
		return { type: "text", text: asText(c.refusal) ?? "" };
	}

	if (contentType === "input_image") {
		const imageUrl = asText(c.image_url);
		if (imageUrl !== undefined) {
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

		const fileId = asText(c.file_id);
		if (fileId !== undefined && fileId.length > 0) {
			return { type: "text", text: `[image file_id: ${fileId}]` };
		}

		return { type: "text", text: "[image content omitted]" };
	}

	warnings.warn(
		contentType === undefined
			? "Dropping content part with a non-string type"
			: `Unknown content type "${contentType}" — content dropped`,
	);
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
	const warnings = createTranslationWarnings();

	for (const rawItem of req.input as unknown[]) {
		// `input` is untrusted client JSON, so an item is only safe to read once
		// it is known to be a plain object — reading `.type` off a null,
		// primitive or array item would throw out of the handler as a 500.
		if (
			rawItem === null ||
			typeof rawItem !== "object" ||
			Array.isArray(rawItem)
		) {
			warnings.warn(
				"Dropping malformed Responses input item — expected an object",
			);
			continue;
		}
		const item = rawItem as ResponseItem;
		// A present-but-non-string `type` matches no branch below, so it would
		// fall through silently; skip it here rather than coercing it to a
		// string for the comparisons.
		if (item.type !== undefined && typeof item.type !== "string") {
			warnings.warn(
				"Dropping malformed Responses input item — type must be a string",
			);
			continue;
		}

		if (item.type === "message" || item.type === undefined) {
			const rawContent: unknown = item.content;
			// A message whose content is neither the string shorthand nor a
			// parts array has nothing to translate; skip it rather than
			// emitting an empty-content message.
			if (typeof rawContent !== "string" && !Array.isArray(rawContent)) {
				warnings.warn(
					"Dropping malformed Responses message — content must be a string or an array",
				);
				continue;
			}
			const content: AnthropicContent[] =
				typeof rawContent === "string"
					? [{ type: "text", text: rawContent }]
					: rawContent.map((c) => translateContentItem(c, warnings));
			// developer role is used by Codex CLI, and system role by Codex
			// VS Code clients, for system-level instructions. Anthropic
			// /v1/messages does not accept either role in the messages array
			// so we extract the text and merge it into the system prompt instead.
			if (item.role === "developer" || item.role === "system") {
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
				name: getTranslatedToolName(item.name, item.namespace),
				input:
					item.type === "custom_tool_call"
						? { input: item.input }
						: parseArguments(item.arguments),
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
						content:
							typeof item.output === "string"
								? item.output
								: Array.isArray(item.output)
									? item.output.map((c) => translateContentItem(c, warnings))
									: "",
					},
				],
			});
		}
	}

	const mergedMessages = mergeConsecutiveSameRole(messages);

	const result: AnthropicRequest = {
		model: mapGptModelToClaudeFamily(asText(req.model) ?? ""),
		messages: mergedMessages,
		max_tokens: req.max_output_tokens ?? 4096,
	};

	// Merge developer-role blocks and req.instructions into system prompt.
	const systemParts: string[] = [];
	if (developerBlocks.length > 0)
		systemParts.push(developerBlocks.join("\n\n"));
	// Only a string is pushed: `systemParts` is joined below, so a non-string
	// would be coerced here and could throw.
	const instructions = asText(req.instructions);
	if (instructions !== undefined) systemParts.push(instructions);
	if (systemParts.length > 0) result.system = systemParts.join("\n\n");

	if (req.stream !== undefined) {
		result.stream = req.stream;
	}

	const translatedTools = translateTools(getRequestTools(req), warnings);
	if (translatedTools.length > 0) {
		result.tools = translatedTools;
		const toolChoice = translateToolChoice(req.tool_choice);
		if (toolChoice !== undefined) {
			result.tool_choice = toolChoice;
		}
	}

	// Last, so tool warnings count too: report what the per-request cap
	// suppressed, keeping a request that dropped a lot visible as one line.
	warnings.flush();

	return result;
}
