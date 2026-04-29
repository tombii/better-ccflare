import { validateEndpointUrl } from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

const log = new Logger("CodexProvider");

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_VERSION = "0.125.0";
const CODEX_USER_AGENT = `codex-cli/${CODEX_VERSION} (Windows 10.0.26100; x64)`;

// Default model mapping: Anthropic model name prefixes → Codex model names
const DEFAULT_MODEL_MAP: Record<string, string> = {
	opus: "gpt-5.3-codex",
	sonnet: "gpt-5.3-codex",
	haiku: "gpt-5.4-mini",
};

// ── Codex Responses API types ─────────────────────────────────────────────────

interface CodexInputTextItem {
	type: "input_text";
	text: string;
}

interface CodexOutputTextItem {
	type: "output_text";
	text: string;
}

interface CodexFunctionCallItem {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
}

interface CodexFunctionCallOutputItem {
	type: "function_call_output";
	call_id: string;
	output: string;
}

type CodexContentItem =
	| CodexInputTextItem
	| CodexOutputTextItem
	| CodexFunctionCallItem
	| CodexFunctionCallOutputItem;

interface CodexMessage {
	role: "user" | "assistant";
	content: CodexContentItem[];
}

interface CodexTool {
	type: "function";
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

interface CodexRequest {
	model: string;
	input: (CodexMessage | CodexFunctionCallItem | CodexFunctionCallOutputItem)[];
	stream: true;
	store: false;
	reasoning?: { effort: string };
	instructions?: string;
	tools?: CodexTool[];
}

// ── Anthropic request types ───────────────────────────────────────────────────

interface AnthropicTextContent {
	type: "text";
	text: string;
}

interface AnthropicToolUse {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface AnthropicToolResult {
	type: "tool_result";
	tool_use_id: string;
	content: string | AnthropicTextContent[];
}

type AnthropicContentBlock =
	| AnthropicTextContent
	| AnthropicToolUse
	| AnthropicToolResult;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description?: string;
	input_schema?: Record<string, unknown>;
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?: string | { type: string; text: string }[];
	stream?: boolean;
	tools?: AnthropicTool[];
	[key: string]: unknown;
}

// ── SSE streaming state ───────────────────────────────────────────────────────

interface ContextWindowUsage {
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

interface ContextWindow {
	current_usage: ContextWindowUsage;
	context_window_size: number;
}

interface StreamState {
	buffer: string;
	messageId: string;
	contentBlockIndex: number;
	hasSentMessageStart: boolean;
	hasSentContentBlockStart: boolean;
	hasSentTerminalEvents: boolean;
	inputTokens: number;
	outputTokens: number;
	contextWindow: ContextWindow | null;
	// Track function_call items: output_index → content_block_index
	functionCallBlocks: Map<number, number>;
}

export class CodexProvider extends BaseProvider {
	name = "codex";

	canHandle(path: string): boolean {
		// Codex only handles /v1/messages; reject token counting etc.
		return path === "/v1/messages";
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(`No refresh token for account ${account.name}`);
		}

		log.info(`Refreshing Codex token for account ${account.name}`);

		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: account.refresh_token,
			client_id: CLIENT_ID,
			scope:
				"openid profile email offline_access api.connectors.read api.connectors.invoke",
		});

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!response.ok) {
			let errorData: { error?: string; error_description?: string } | null =
				null;
			try {
				errorData = await response.json();
			} catch {
				// ignore
			}

			const errorMessage =
				errorData?.error_description || errorData?.error || response.statusText;

			// Rotating refresh tokens: reuse → must re-auth
			if (errorData?.error === "refresh_token_reused") {
				throw new Error(
					`Codex refresh token was reused for account ${account.name}. Please re-authenticate with: bun run cli --reauthenticate ${account.name}`,
				);
			}

			throw new Error(
				`Failed to refresh Codex token for account ${account.name}: ${errorMessage}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		log.debug(`[CodexProvider] token refresh response for ${account.name}:`, {
			expiresIn: json.expires_in,
			responseKeys: Object.keys(json),
		});

		return {
			accessToken: json.access_token,
			// OpenAI issues a new refresh token on each refresh (rotating)
			refreshToken: json.refresh_token,
			expiresAt: Date.now() + json.expires_in * 1000,
		};
	}

	buildUrl(_path: string, _query: string, account?: Account): string {
		if (account?.custom_endpoint) {
			try {
				return validateEndpointUrl(account.custom_endpoint, "custom_endpoint");
			} catch (error) {
				log.warn(
					`Invalid custom endpoint for ${account.name}: ${account.custom_endpoint}. Using default.`,
					error,
				);
			}
		}
		return DEFAULT_ENDPOINT;
	}

	prepareHeaders(headers: Headers, accessToken?: string): Headers {
		const newHeaders = new Headers(headers);

		// Remove client auth and Anthropic-specific headers
		newHeaders.delete("authorization");
		newHeaders.delete("anthropic-version");
		newHeaders.delete("anthropic-dangerous-direct-browser-access");
		newHeaders.delete("anthropic-beta");
		newHeaders.delete("x-api-key");
		newHeaders.delete("host");

		// Set Codex-required headers
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		}
		newHeaders.set("Version", CODEX_VERSION);
		newHeaders.set("Openai-Beta", "responses=experimental");
		newHeaders.set("User-Agent", CODEX_USER_AGENT);
		newHeaders.set("originator", "codex_cli_rs");

		return newHeaders;
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return request;
		}

		try {
			const body = (await request.json()) as AnthropicRequest;
			const codexBody = this.convertToCodexFormat(body, account);

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(codexBody),
			});
		} catch (error) {
			log.error("Failed to transform request body to Codex format:", error);
			return request;
		}
	}

	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		const contentType = response.headers.get("content-type");
		const isEventStream = contentType?.includes("text/event-stream") ?? false;
		const shouldForceStreamingTransform =
			response.ok && response.body !== null && !isEventStream;

		if (shouldForceStreamingTransform) {
			log.warn(
				`Codex returned a successful response with unexpected content-type ${contentType ?? "<missing>"}; attempting SSE transformation`,
			);
		}

		if (isEventStream || shouldForceStreamingTransform) {
			return this.transformStreamingResponse(response);
		}

		// Non-streaming errors should pass through with sanitized headers so callers see the upstream failure body.
		const headers = sanitizeProxyHeaders(response.headers);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Parse reset time from Codex usage headers (present on all responses)
		const parseReset = (v: string | null) =>
			v ? Number.parseInt(v, 10) * 1000 : undefined;

		// Try primary/secondary headers first, then legacy x-codex-5h/7d headers
		const resets = [
			parseReset(response.headers.get("x-codex-primary-reset-at")),
			parseReset(response.headers.get("x-codex-secondary-reset-at")),
			parseReset(response.headers.get("x-codex-5h-reset-at")),
			parseReset(response.headers.get("x-codex-7d-reset-at")),
		].filter((v): v is number => v !== undefined);

		// Use the sooner (smallest) reset time
		const resetTime = resets.length > 0 ? Math.min(...resets) : undefined;

		if (response.status !== 429) {
			// Return reset time for DB tracking even on successful responses
			return { isRateLimited: false, resetTime };
		}

		return {
			isRateLimited: true,
			resetTime: resetTime ?? Date.now() + 60 * 60 * 1000,
		};
	}

	supportsOAuth(): boolean {
		return true;
	}

	getOAuthProvider() {
		const { CodexOAuthProvider } = require("./oauth.js");
		return new CodexOAuthProvider();
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	private mapModel(anthropicModel: string, account?: Account): string {
		// Account-level overrides take priority
		if (account?.model_mappings) {
			try {
				const mappings =
					typeof account.model_mappings === "string"
						? (JSON.parse(account.model_mappings) as Record<string, string>)
						: (account.model_mappings as Record<string, string>);

				const lower = anthropicModel.toLowerCase();
				if (mappings[anthropicModel]) return mappings[anthropicModel];
				if (lower.includes("haiku") && mappings.haiku) return mappings.haiku;
				if (lower.includes("sonnet") && mappings.sonnet) return mappings.sonnet;
				if (lower.includes("opus") && mappings.opus) return mappings.opus;
			} catch {
				// ignore malformed mappings
			}
		}

		// Default mapping by model family
		const lower = anthropicModel.toLowerCase();
		if (lower.includes("haiku")) return DEFAULT_MODEL_MAP.haiku;
		if (lower.includes("sonnet")) return DEFAULT_MODEL_MAP.sonnet;
		if (lower.includes("opus")) return DEFAULT_MODEL_MAP.opus;
		return anthropicModel;
	}

	private extractSystemPrompt(
		system: AnthropicRequest["system"],
	): string | undefined {
		if (!system) return undefined;
		if (typeof system === "string") return system;
		// Array of content blocks
		return system
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n\n");
	}

	private convertMessage(
		msg: AnthropicMessage,
	): (CodexMessage | CodexFunctionCallItem | CodexFunctionCallOutputItem)[] {
		const items: (
			| CodexMessage
			| CodexFunctionCallItem
			| CodexFunctionCallOutputItem
		)[] = [];

		if (typeof msg.content === "string") {
			const contentType = msg.role === "user" ? "input_text" : "output_text";
			items.push({
				role: msg.role,
				content: [{ type: contentType, text: msg.content } as CodexContentItem],
			} as CodexMessage);
			return items;
		}

		// Complex content array — may contain tool_use, tool_result, text
		const textBlocks: CodexContentItem[] = [];
		const functionCalls: CodexFunctionCallItem[] = [];
		const functionCallOutputs: CodexFunctionCallOutputItem[] = [];

		for (const block of msg.content) {
			if (block.type === "text") {
				const contentType = msg.role === "user" ? "input_text" : "output_text";
				textBlocks.push({
					type: contentType,
					text: block.text,
				} as CodexContentItem);
			} else if (block.type === "tool_use") {
				functionCalls.push({
					type: "function_call",
					call_id: block.id,
					name: block.name,
					arguments: JSON.stringify(block.input || {}),
				});
			} else if (block.type === "tool_result") {
				const outputText =
					typeof block.content === "string"
						? block.content
						: Array.isArray(block.content)
							? block.content
									.filter((b) => b.type === "text")
									.map((b) => b.text)
									.join("\n")
							: "";
				functionCallOutputs.push({
					type: "function_call_output",
					call_id: block.tool_use_id,
					output: outputText,
				});
			}
		}

		// Text content goes in a message wrapper; function_call* are top-level items
		if (textBlocks.length > 0) {
			items.push({ role: msg.role, content: textBlocks } as CodexMessage);
		}
		for (const fc of functionCalls) {
			items.push(fc);
		}
		for (const fco of functionCallOutputs) {
			items.push(fco);
		}

		return items;
	}

	private extractContextWindow(
		response: Record<string, unknown> | undefined,
		usage: { input_tokens?: number } | undefined,
	): ContextWindow | null {
		const contextWindow = response?.context_window as
			| Record<string, unknown>
			| undefined;
		if (!contextWindow) return null;

		const contextWindowSize = contextWindow.context_window_size;
		if (
			typeof contextWindowSize !== "number" ||
			!Number.isFinite(contextWindowSize) ||
			contextWindowSize <= 0
		)
			return null;

		const currentUsage = contextWindow.current_usage as
			| Record<string, unknown>
			| undefined;
		const inputTokens = currentUsage?.input_tokens;
		const normalizedInputTokens =
			typeof inputTokens === "number" && Number.isFinite(inputTokens)
				? inputTokens
				: usage?.input_tokens;
		if (
			typeof normalizedInputTokens !== "number" ||
			!Number.isFinite(normalizedInputTokens) ||
			normalizedInputTokens < 0
		)
			return null;

		const cacheReadInputTokens = currentUsage?.cache_read_input_tokens;
		const cacheCreationInputTokens = currentUsage?.cache_creation_input_tokens;

		return {
			current_usage: {
				input_tokens: normalizedInputTokens,
				cache_read_input_tokens:
					typeof cacheReadInputTokens === "number" &&
					Number.isFinite(cacheReadInputTokens) &&
					cacheReadInputTokens >= 0
						? cacheReadInputTokens
						: 0,
				cache_creation_input_tokens:
					typeof cacheCreationInputTokens === "number" &&
					Number.isFinite(cacheCreationInputTokens) &&
					cacheCreationInputTokens >= 0
						? cacheCreationInputTokens
						: 0,
			},
			context_window_size: contextWindowSize,
		};
	}

	private convertToCodexFormat(
		body: AnthropicRequest,
		account?: Account,
	): CodexRequest {
		const model = this.mapModel(body.model, account);
		const instructions = this.extractSystemPrompt(body.system);

		// Convert messages
		const input: CodexRequest["input"] = [];
		for (const msg of body.messages) {
			const items = this.convertMessage(msg);
			for (const item of items) {
				input.push(item);
			}
		}

		// Convert tools
		let tools: CodexTool[] | undefined;
		if (body.tools && body.tools.length > 0) {
			tools = body.tools.map((t) => ({
				type: "function" as const,
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			}));
		}

		const codexRequest: CodexRequest = {
			model,
			input,
			stream: true,
			store: false,
			reasoning: { effort: "medium" },
		};

		codexRequest.instructions = instructions || "You are a helpful assistant.";
		if (tools) {
			codexRequest.tools = tools;
		}

		return codexRequest;
	}

	private transformStreamingResponse(response: Response): Response {
		const state: StreamState = {
			buffer: "",
			messageId: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
			contentBlockIndex: 0,
			hasSentMessageStart: false,
			hasSentContentBlockStart: false,
			hasSentTerminalEvents: false,
			inputTokens: 0,
			outputTokens: 0,
			contextWindow: null,
			functionCallBlocks: new Map(),
		};

		const headers = sanitizeProxyHeaders(response.headers);
		headers.set("content-type", "text/event-stream");

		const { readable, writable } = new TransformStream<
			Uint8Array,
			Uint8Array
		>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const writeSSE = async (event: string, data: unknown) => {
			const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			await writer.write(encoder.encode(line));
		};

		const processEvents = async () => {
			try {
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Response body is not readable");

				while (true) {
					const { value, done } = await reader.read();
					if (done) break;

					state.buffer += decoder.decode(value, { stream: true });

					// Process complete SSE events in buffer
					while (true) {
						const newlineIdx = state.buffer.indexOf("\n\n");
						if (newlineIdx === -1) break;

						const eventText = state.buffer.slice(0, newlineIdx);
						state.buffer = state.buffer.slice(newlineIdx + 2);

						const eventLine = eventText
							.split("\n")
							.find((l) => l.startsWith("event:"));
						const dataLine = eventText
							.split("\n")
							.find((l) => l.startsWith("data:"));

						if (!eventLine || !dataLine) continue;

						const eventName = eventLine.slice("event:".length).trim();
						const dataStr = dataLine.slice("data:".length).trim();

						if (dataStr === "[DONE]") continue;

						let data: Record<string, unknown>;
						try {
							data = JSON.parse(dataStr);
						} catch {
							continue;
						}

						await this.handleCodexEvent(eventName, data, state, writeSSE);
					}
				}

				// Flush any remaining
				if (!state.hasSentMessageStart) {
					await writeSSE("message_start", {
						type: "message_start",
						message: {
							id: state.messageId,
							type: "message",
							role: "assistant",
							content: [],
							model: "gpt-5.3-codex",
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 0, output_tokens: 0 },
						},
					});
				}

				// Close any open content block
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
				}

				// Final message_delta + message_stop if upstream never sent response.completed
				if (!state.hasSentTerminalEvents) {
					await writeSSE("message_delta", {
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: state.outputTokens },
					});
					await writeSSE("message_stop", { type: "message_stop" });
				}
			} catch (error) {
				log.error("Error processing Codex SSE stream:", error);
			} finally {
				await writer.close();
			}
		};

		processEvents();

		return new Response(readable, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private async handleCodexEvent(
		eventName: string,
		data: Record<string, unknown>,
		state: StreamState,
		writeSSE: (event: string, data: unknown) => Promise<void>,
	): Promise<void> {
		switch (eventName) {
			case "response.created": {
				const resp = data.response as Record<string, unknown> | undefined;
				const respId = (resp?.id as string) || state.messageId;
				const model = (resp?.model as string) || "gpt-5.3-codex";

				state.messageId = respId;
				state.hasSentMessageStart = true;

				await writeSSE("message_start", {
					type: "message_start",
					message: {
						id: respId,
						type: "message",
						role: "assistant",
						content: [],
						model,
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: state.inputTokens,
							output_tokens: 0,
						},
					},
				});
				break;
			}

			case "response.output_item.added": {
				const item = data.item as Record<string, unknown> | undefined;
				const outputIndex = data.output_index as number | undefined;
				const itemType = item?.type as string | undefined;

				if (itemType === "message") {
					// Text content block will start on content_part.added
					// Nothing to emit yet
				} else if (itemType === "function_call") {
					// Start a tool_use content block
					const callId = item?.call_id as string;
					const name = item?.name as string;
					const blockIdx = state.contentBlockIndex;

					if (outputIndex !== undefined) {
						state.functionCallBlocks.set(outputIndex, blockIdx);
					}

					if (state.hasSentContentBlockStart) {
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: blockIdx,
						});
						state.contentBlockIndex++;
					}

					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: state.contentBlockIndex,
						content_block: {
							type: "tool_use",
							id: callId,
							name,
							input: {},
						},
					});
					state.hasSentContentBlockStart = true;
				}
				break;
			}

			case "response.content_part.added": {
				const part = data.part as Record<string, unknown> | undefined;
				const partType = part?.type as string | undefined;

				if (partType === "output_text") {
					// Start a text content block
					if (state.hasSentContentBlockStart) {
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: state.contentBlockIndex,
						});
						state.contentBlockIndex++;
					}

					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: state.contentBlockIndex,
						content_block: { type: "text", text: "" },
					});
					state.hasSentContentBlockStart = true;
				}
				break;
			}

			case "response.output_text.delta": {
				const delta = data.delta as string | undefined;
				if (delta) {
					await writeSSE("content_block_delta", {
						type: "content_block_delta",
						index: state.contentBlockIndex,
						delta: { type: "text_delta", text: delta },
					});
				}
				break;
			}

			case "response.function_call_arguments.delta": {
				const delta = data.delta as string | undefined;
				if (delta) {
					await writeSSE("content_block_delta", {
						type: "content_block_delta",
						index: state.contentBlockIndex,
						delta: { type: "input_json_delta", partial_json: delta },
					});
				}
				break;
			}

			case "response.output_item.done": {
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
					state.contentBlockIndex++;
					state.hasSentContentBlockStart = false;
				}
				break;
			}

			case "response.completed": {
				const resp = data.response as Record<string, unknown> | undefined;
				const usage = resp?.usage as
					| { input_tokens?: number; output_tokens?: number }
					| undefined;

				state.inputTokens = usage?.input_tokens || state.inputTokens;
				state.outputTokens = usage?.output_tokens || state.outputTokens;
				state.contextWindow = this.extractContextWindow(resp, usage);

				// Close any lingering content block
				if (state.hasSentContentBlockStart) {
					await writeSSE("content_block_stop", {
						type: "content_block_stop",
						index: state.contentBlockIndex,
					});
					state.hasSentContentBlockStart = false;
				}

				const messageDelta: {
					type: "message_delta";
					delta: { stop_reason: "end_turn"; stop_sequence: null };
					usage: { output_tokens: number };
					context_window?: ContextWindow;
				} = {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: state.outputTokens },
				};
				if (state.contextWindow) {
					messageDelta.context_window = state.contextWindow;
				}

				await writeSSE("message_delta", messageDelta);
				await writeSSE("message_stop", { type: "message_stop" });
				state.hasSentTerminalEvents = true;
				break;
			}
			default:
				// Ignore unknown events
				break;
		}
	}
}
