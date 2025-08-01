import { Bot, FileText, MessageSquare, Terminal, User } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

// Helper function to clean line numbers from content
function cleanLineNumbers(content: string): string {
	// Replace line numbers in format "123→" or "123â" with "123: " at the start of lines
	return content.replace(/^(\s*)(\d+)[→â]\s*/gm, "$1$2: ");
}

interface ToolUse {
	id?: string;
	name: string;
	input?: Record<string, unknown>;
}

interface ToolResult {
	tool_use_id: string;
	content: string;
}

interface ContentBlock {
	type: "text" | "tool_use" | "tool_result" | "thinking";
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string;
}

interface Message {
	role: "user" | "assistant" | "system";
	content: string;
	contentBlocks?: ContentBlock[];
	tools?: ToolUse[];
	toolResults?: ToolResult[];
}

interface ConversationViewProps {
	requestBody: string | null;
	responseBody: string | null;
}

function ConversationViewComponent({
	requestBody,
	responseBody,
}: ConversationViewProps) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
	const [expandedThinking, setExpandedThinking] = useState<Set<number>>(
		new Set(),
	);
	const [expandedMessages, setExpandedMessages] = useState<Set<number>>(
		new Set(),
	);
	const [expandedToolInputs, setExpandedToolInputs] = useState<Set<string>>(
		new Set(),
	);

	// Memoized toggle functions
	const toggleThinking = useCallback((index: number) => {
		setExpandedThinking((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	}, []);

	const toggleToolResult = useCallback((key: string) => {
		setExpandedTools((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	const toggleMessage = useCallback((index: number) => {
		setExpandedMessages((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	}, []);

	const toggleToolInput = useCallback((key: string) => {
		setExpandedToolInputs((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	// Parse request body to extract conversation messages
	const requestMessages = useMemo(() => {
		if (!requestBody) return [];

		try {
			const parsed = JSON.parse(requestBody);
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
									id?: string;
									name?: string;
									input?: Record<string, unknown>;
									tool_use_id?: string;
									content?: string;
							  }>;
					}): Message | null => {
						const message: Message = {
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
									let text = item.text || "";
									if (text.includes("<system-reminder>")) {
										text = text
											.split(/<system-reminder>[\s\S]*?<\/system-reminder>/g)
											.join("")
											.trim();
									}
									if (text) {
										textContents.push(text);
										message.contentBlocks?.push({
											type: "text",
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
										type: "tool_use",
										id: item.id,
										name: item.name,
										input: item.input,
									});
								} else if (item.type === "tool_result") {
									message.toolResults?.push({
										tool_use_id: item.tool_use_id || "",
										content: item.content || "",
									});
									message.contentBlocks?.push({
										type: "tool_result",
										tool_use_id: item.tool_use_id,
										content: item.content,
									});
								}
							}

							message.content = textContents.join("\n\n");
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
				.filter((msg: Message | null): msg is Message => msg !== null);
		} catch (error) {
			console.error("Failed to parse request body:", error);
			return [];
		}
	}, [requestBody]);

	// Parse streaming response to extract assistant message
	const assistantMessage = useMemo(() => {
		if (!responseBody) return null;

		try {
			const lines = responseBody.split("\n");
			const message: Message = {
				role: "assistant",
				content: "",
				contentBlocks: [],
				tools: [],
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
									type: "tool_use",
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
									(b) => b.type === "thinking",
								);
								const toolIndex = data.index - (hasThinking ? 1 : 0);
								if (message.tools?.[toolIndex]) {
									try {
										const partialJson = data.delta.partial_json || "";
										// This is a simplified approach - in production you'd want proper JSON streaming
										if (partialJson && message.contentBlocks) {
											const blockIndex = message.contentBlocks.findIndex(
												(b) =>
													b.type === "tool_use" &&
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
					const parsed = JSON.parse(responseBody);
					if (parsed.content) {
						if (typeof parsed.content === "string") {
							currentContent = parsed.content;
						} else if (Array.isArray(parsed.content)) {
							for (const item of parsed.content) {
								if (item.type === "text") {
									currentContent += `${item.text || ""}\n\n`;
									message.contentBlocks?.push({
										type: "text",
										text: item.text,
									});
								} else if (item.type === "tool_use") {
									message.tools?.push({
										id: item.id,
										name: item.name || "unknown",
										input: item.input,
									});
									message.contentBlocks?.push({
										type: "tool_use",
										...item,
									});
								}
							}
						}
					}
				} catch (_e) {
					// Not JSON, might be plain text
					currentContent = responseBody;
				}
			}

			message.content = currentContent.trim();

			if (currentThinking) {
				message.contentBlocks?.unshift({
					type: "thinking",
					thinking: currentThinking,
				});
			}

			if (
				!message.content &&
				!currentThinking &&
				(!message.tools || message.tools.length === 0)
			) {
				return null;
			}

			return message;
		} catch (error) {
			console.error("Failed to parse response body:", error);
			return null;
		}
	}, [responseBody]);

	// Combine messages
	useEffect(() => {
		const allMessages: Message[] = [...requestMessages];
		if (assistantMessage) {
			allMessages.push(assistantMessage);
		}
		setMessages(allMessages);
	}, [requestMessages, assistantMessage]);

	if (messages.length === 0) {
		return (
			<div className="flex items-center justify-center h-32">
				<p className="text-muted-foreground">No conversation data available</p>
			</div>
		);
	}

	return (
		<div className="h-[calc(65vh-10rem)] w-full overflow-hidden">
			<div className="h-full w-full overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3">
				{messages.map((message, index) => {
					// Generate stable key based on message content and position
					const contentPreview = message.content
						? message.content.slice(0, 20).replace(/\s/g, "-")
						: "";
					const messageKey = `msg-${message.role}-${index}-${
						contentPreview ||
						message.tools?.[0]?.name ||
						message.toolResults?.[0]?.tool_use_id ||
						"empty"
					}`;

					return (
						<div
							key={messageKey}
							className={`flex gap-3 w-full ${
								message.role === "assistant" ? "flex-row" : "flex-row-reverse"
							}`}
						>
							<div
								className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
									message.role === "user"
										? "bg-primary text-primary-foreground"
										: message.role === "assistant"
											? "bg-muted"
											: "bg-orange-100 dark:bg-orange-900"
								}`}
							>
								{message.role === "user" ? (
									<User className="w-4 h-4" />
								) : (
									<Bot className="w-4 h-4" />
								)}
							</div>

							<div
								className={`flex-1 min-w-0 ${
									message.role === "user" ? "text-right" : "text-left"
								}`}
							>
								<div
									className={`inline-block max-w-[85%] ${
										message.role === "user" ? "ml-auto" : "mr-auto"
									}`}
								>
									<div className="flex items-center gap-2 mb-1">
										<span className="text-xs font-medium text-muted-foreground">
											{message.role === "user"
												? "User"
												: message.role === "assistant"
													? "Assistant"
													: "System"}
										</span>
										{message.contentBlocks?.some(
											(b) => b.type === "thinking",
										) && (
											<Badge variant="secondary" className="text-xs">
												Thinking
											</Badge>
										)}
										{message.tools && message.tools.length > 0 && (
											<Badge variant="outline" className="text-xs">
												<Terminal className="w-3 h-3 mr-1" />
												{message.tools.length} tool
												{message.tools.length > 1 ? "s" : ""} used
											</Badge>
										)}
										{message.toolResults && message.toolResults.length > 0 && (
											<Badge variant="secondary" className="text-xs">
												<FileText className="w-3 h-3 mr-1" />
												{message.toolResults.length} result
												{message.toolResults.length > 1 ? "s" : ""}
											</Badge>
										)}
									</div>

									{/* Thinking block */}
									{message.contentBlocks?.some((b) => b.type === "thinking") &&
										(() => {
											const thinkingBlock = message.contentBlocks?.find(
												(b) => b.type === "thinking",
											);
											const rawThinking = thinkingBlock?.thinking || "";
											const thinkingContent = cleanLineNumbers(rawThinking);
											const isExpanded = expandedThinking.has(index);
											const isLong =
												thinkingContent && thinkingContent.length > 200;

											return (
												<div className="mb-2 p-3 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded-lg">
													<div className="flex items-center justify-between mb-1">
														<div className="flex items-center gap-2">
															<MessageSquare className="w-3 h-3 text-yellow-600 dark:text-yellow-400" />
															<span className="text-xs font-medium text-yellow-600 dark:text-yellow-400">
																Thinking
															</span>
														</div>
														{isLong && (
															<Button
																variant="ghost"
																size="sm"
																className="h-5 px-2 text-xs"
																onClick={() => toggleThinking(index)}
															>
																{isExpanded ? "Show less" : "Show more"}
															</Button>
														)}
													</div>
													<div className="text-xs text-yellow-700 dark:text-yellow-300 whitespace-pre-wrap break-words">
														{isExpanded || !isLong
															? thinkingContent
															: thinkingContent
																? `${thinkingContent.slice(0, 200)}...`
																: ""}
													</div>
												</div>
											);
										})()}

									{/* Main content */}
									{message.content &&
										(() => {
											const cleanedContent = cleanLineNumbers(message.content);
											const isExpanded = expandedMessages.has(index);
											const isLong = cleanedContent.length > 300;

											return (
												<div>
													<div
														className={`rounded-lg px-4 py-2 ${
															message.role === "user"
																? "bg-primary text-primary-foreground"
																: message.role === "assistant"
																	? "bg-muted"
																	: "bg-orange-100 dark:bg-orange-900"
														}`}
													>
														<div
															className={`whitespace-pre-wrap break-words text-sm ${
																isExpanded && isLong
																	? "max-h-96 overflow-y-auto pr-2"
																	: ""
															}`}
														>
															{isExpanded || !isLong
																? cleanedContent
																: `${cleanedContent.slice(0, 300)}...`}
														</div>
													</div>
													{isLong && (
														<Button
															variant="ghost"
															size="sm"
															className="mt-1 h-6 px-2 text-xs"
															onClick={() => toggleMessage(index)}
														>
															{isExpanded ? "Show less" : "Show more"}
														</Button>
													)}
												</div>
											);
										})()}

									{/* Tool usage */}
									{message.tools && message.tools.length > 0 && (
										<div className="mt-2 space-y-2">
											{message.tools.map((tool, toolIndex) => {
												const toolKey = `${index}-tool-${toolIndex}`;
												const inputStr = tool.input
													? JSON.stringify(tool.input, null, 2)
													: "";
												const isExpanded = expandedToolInputs.has(toolKey);
												const isLong = inputStr.length > 200;

												return (
													<div
														key={`tool-${tool.id || tool.name}-${toolIndex}`}
														className="p-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg"
													>
														<div className="flex items-center justify-between mb-1">
															<div className="flex items-center gap-2">
																<Terminal className="w-3 h-3 text-blue-600 dark:text-blue-400" />
																<span className="text-xs font-medium text-blue-600 dark:text-blue-400">
																	Tool: {tool.name}
																</span>
															</div>
															{tool.input &&
																Object.keys(tool.input).length > 0 &&
																isLong && (
																	<Button
																		variant="ghost"
																		size="sm"
																		className="h-6 px-2 text-xs"
																		onClick={() => toggleToolInput(toolKey)}
																	>
																		{isExpanded ? "Show less" : "Show more"}
																	</Button>
																)}
														</div>
														{tool.input &&
															Object.keys(tool.input).length > 0 && (
																<pre
																	className={`text-xs bg-blue-100/50 dark:bg-blue-900/20 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap break-words ${
																		isExpanded && isLong
																			? "max-h-96 overflow-y-auto pr-2"
																			: ""
																	}`}
																>
																	{isExpanded || !isLong
																		? inputStr
																		: `${inputStr.slice(0, 200)}...`}
																</pre>
															)}
													</div>
												);
											})}
										</div>
									)}

									{/* Tool results */}
									{message.toolResults && message.toolResults.length > 0 && (
										<div className="mt-2 space-y-2">
											{message.toolResults.map((result, resultIndex) => {
												const resultKey = `${index}-result-${resultIndex}`;
												const isExpanded = expandedTools.has(resultKey);
												const rawContent = result.content || "";
												const content = cleanLineNumbers(rawContent);
												const isLong = content && content.length > 200;

												return (
													<div
														key={`result-${result.tool_use_id || resultIndex}`}
														className="p-3 bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg"
													>
														<div className="flex items-center justify-between mb-1">
															<div className="flex items-center gap-2">
																<FileText className="w-3 h-3 text-green-600 dark:text-green-400" />
																<span className="text-xs font-medium text-green-600 dark:text-green-400">
																	Tool Result
																</span>
															</div>
															{isLong && (
																<Button
																	variant="ghost"
																	size="sm"
																	className="h-6 px-2 text-xs"
																	onClick={() => toggleToolResult(resultKey)}
																>
																	{isExpanded ? "Show less" : "Show more"}
																</Button>
															)}
														</div>
														<div className="text-xs bg-green-100/50 dark:bg-green-900/20 p-2 rounded mt-1 overflow-hidden">
															<pre
																className={`overflow-x-auto whitespace-pre-wrap break-words ${
																	isExpanded && isLong
																		? "max-h-96 overflow-y-auto pr-2"
																		: ""
																}`}
															>
																{isExpanded || !isLong
																	? content
																	: content
																		? `${content.slice(0, 200)}...`
																		: ""}
															</pre>
														</div>
													</div>
												);
											})}
										</div>
									)}
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

export const ConversationView = React.memo(ConversationViewComponent);
