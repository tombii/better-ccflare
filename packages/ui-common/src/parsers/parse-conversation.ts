import {
	ContentBlockType,
	type MessageData,
	type ToolUse,
} from "@better-ccflare/types";
import { normalizeText } from "../utils/normalize-text";

export function parseRequestMessages(body: string | null): MessageData[] {
	if (!body) return [];

	try {
		const parsed = JSON.parse(body);
		if (!parsed.messages || !Array.isArray(parsed.messages)) return [];

		return parsed.messages
			.map(
				(msg: {
					role: "user" | "assistant" | "system";
					content:
						| string
						| Array<{
								type: string;
								text?: string;
								thinking?: string;
								id?: string;
								name?: string;
								input?: Record<string, unknown>;
								tool_use_id?: string;
								content?: string | Array<{ type: string; text?: string }>;
						  }>;
				}): MessageData | null => {
					const message: MessageData = {
						role: msg.role,
						content: "",
						contentBlocks: [],
						tools: [],
						toolResults: [],
					};

					if (typeof msg.content === "string") {
						message.content = msg.content;
					} else if (Array.isArray(msg.content)) {
						// Process content blocks
						const textContents: string[] = [];

						for (const item of msg.content) {
							if (item.type === "text") {
								// Filter out system reminders
								let text = normalizeText(item.text || "");
								if (text.includes("<system-reminder>")) {
									text = text
										.split(/<system-reminder>[\s\S]*?<\/system-reminder>/g)
										.join("")
										.trim();
								}
								if (text) {
									textContents.push(text);
									message.contentBlocks?.push({
										type: ContentBlockType.Text,
										text,
									});
								}
							} else if (item.type === "tool_use") {
								message.tools?.push({
									id: item.id,
									name: item.name || "unknown",
									input: item.input,
								});
								message.contentBlocks?.push({
									type: ContentBlockType.ToolUse,
									id: item.id,
									name: item.name,
									input: item.input,
								});
							} else if (item.type === "tool_result") {
								const resultContent = Array.isArray(item.content)
									? (
											item.content as Array<{
												type: string;
												text?: string;
											}>
										)
											.map((c) =>
												normalizeText(typeof c.text === "string" ? c.text : ""),
											)
											.join("")
									: typeof item.content === "string"
										? normalizeText(item.content as string)
										: "";
								message.toolResults?.push({
									tool_use_id: item.tool_use_id || "",
									content: resultContent,
								});
								message.contentBlocks?.push({
									type: ContentBlockType.ToolResult,
									tool_use_id: item.tool_use_id,
									content: resultContent,
								});
							} else if (item.type === "thinking") {
								const thinking = normalizeText(item.thinking || "");
								if (thinking) {
									message.contentBlocks?.push({
										type: ContentBlockType.Thinking,
										thinking,
									});
								}
							}
						}

						message.content = textContents.join("\n\n").trim();
						if (
							!message.content &&
							message.tools?.length === 0 &&
							message.toolResults?.length === 0
						) {
							return null;
						}
					}

					return message;
				},
			)
			.filter((msg: MessageData | null): msg is MessageData => msg !== null);
	} catch (error) {
		console.error("Failed to parse request body:", error);
		return [];
	}
}

export function parseAssistantMessage(body: string | null): MessageData | null {
	if (!body) return null;

	try {
		const lines = body.split("\n");
		const message: MessageData = {
			role: "assistant",
			content: "",
			contentBlocks: [],
			tools: [],
			toolResults: [],
		};

		let currentContent = "";
		let currentThinking = "";
		let isStreaming = false;

		for (const line of lines) {
			if (line.startsWith("event:")) {
				isStreaming = true;
				continue;
			}

			if (line.startsWith("data:")) {
				const dataStr = line.substring(5).trim();
				if (!dataStr || dataStr === "[DONE]") continue;

				try {
					const data = JSON.parse(dataStr);

					// Handle different event types
					if (data.type === "content_block_start") {
						if (data.content_block?.type === "tool_use") {
							const tool: ToolUse = {
								id: data.content_block.id,
								name: data.content_block.name,
								input: {},
							};
							message.tools?.push(tool);
							message.contentBlocks?.push({
								type: ContentBlockType.ToolUse,
								id: data.content_block.id,
								name: data.content_block.name,
								input: {},
							});
						} else if (data.content_block?.type === "thinking") {
							// Thinking block will be added when content is received
						}
					} else if (data.type === "content_block_delta") {
						if (data.delta?.type === "text_delta") {
							currentContent += data.delta.text || "";
						} else if (data.delta?.type === "thinking_delta") {
							currentThinking += data.delta.thinking || "";
						} else if (
							data.delta?.type === "input_json_delta" &&
							data.index !== undefined
						) {
							// Update tool input
							const hasThinking = message.contentBlocks?.some(
								(b) => b.type === ContentBlockType.Thinking,
							);
							const toolIndex = data.index - (hasThinking ? 1 : 0);
							if (message.tools?.[toolIndex]) {
								try {
									const partialJson = data.delta.partial_json || "";
									// This is a simplified approach - in production you'd want proper JSON streaming
									if (partialJson && message.contentBlocks) {
										const blockIndex = message.contentBlocks.findIndex(
											(b) =>
												b.type === ContentBlockType.ToolUse &&
												b.id === message.tools?.[toolIndex].id,
										);
										if (blockIndex !== -1) {
											// Try to parse the partial JSON, fallback to empty object
											try {
												message.contentBlocks[blockIndex].input =
													JSON.parse(partialJson);
											} catch {
												// If parsing fails, store raw string in a temporary field
												message.contentBlocks[blockIndex].input = {
													_partial: partialJson,
												};
											}
										}
									}
								} catch (_e) {
									// Ignore JSON parsing errors for partial data
								}
							}
						}
					}
				} catch (_e) {
					// Skip invalid JSON
				}
			}
		}

		// If no streaming data found, try parsing as direct response
		if (!isStreaming) {
			try {
				const parsed = JSON.parse(body);
				if (parsed.content) {
					if (typeof parsed.content === "string") {
						currentContent = normalizeText(parsed.content);
					} else if (Array.isArray(parsed.content)) {
						for (const item of parsed.content) {
							if (item.type === "text" && item.text) {
								const norm = normalizeText(item.text);
								currentContent += norm;
								message.contentBlocks?.push({
									type: ContentBlockType.Text,
									text: norm,
								});
							} else if (item.type === "tool_use") {
								message.tools?.push({
									id: item.id,
									name: item.name || "unknown",
									input: item.input,
								});
								message.contentBlocks?.push({
									type: ContentBlockType.ToolUse,
									...item,
								});
							} else if (item.type === "thinking") {
								const thinking = normalizeText(item.thinking || "");
								if (thinking) {
									message.contentBlocks?.push({
										type: ContentBlockType.Thinking,
										thinking,
									});
								}
							} else if (item.type === "tool_result") {
								const resultContent = Array.isArray(item.content)
									? (
											item.content as Array<{
												type: string;
												text?: string;
											}>
										)
											.map((c) =>
												normalizeText(typeof c.text === "string" ? c.text : ""),
											)
											.join("")
									: typeof item.content === "string"
										? normalizeText(item.content as string)
										: "";
								message.toolResults?.push({
									tool_use_id: item.tool_use_id || "",
									content: resultContent,
								});
								message.contentBlocks?.push({
									type: ContentBlockType.ToolResult,
									tool_use_id: item.tool_use_id,
									content: resultContent,
								});
							}
						}
					}
				}
			} catch (_e) {
				// Not JSON, might be plain text
				currentContent = body;
			}
		}

		message.content = currentContent.trim();

		if (currentThinking) {
			message.contentBlocks?.unshift({
				type: ContentBlockType.Thinking,
				thinking: currentThinking,
			});
		}

		if (
			!message.content &&
			!currentThinking &&
			(!message.tools || message.tools.length === 0) &&
			(!message.toolResults || message.toolResults.length === 0)
		) {
			return null;
		}

		return message;
	} catch (error) {
		console.error("Failed to parse response body:", error);
		return null;
	}
}
