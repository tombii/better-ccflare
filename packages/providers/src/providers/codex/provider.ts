import {
	mapModelName,
	ValidationError,
	validateEndpointUrl,
} from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { resolveReasoningEffort } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

const log = new Logger("CodexProvider");

const INTERNAL_HEADERS = [
	"x-better-ccflare-request-id",
	"x-better-ccflare-request-stream",
];

function sanitizeResponseHeaders(headers: Headers): Headers {
	const sanitized = sanitizeProxyHeaders(headers);
	for (const h of INTERNAL_HEADERS) {
		sanitized.delete(h);
	}
	return sanitized;
}

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEFAULT_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/responses";
export const CODEX_VERSION = "0.130.0";
export const CODEX_USER_AGENT = `codex-cli/${CODEX_VERSION} (Windows 10.0.26100; x64)`;
export const CODEX_PING_MODEL = "gpt-5-codex";

const _normalizeUsage = (value: unknown): Record<string, number> => {
	const usage =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	const getNumber = (field: string) => {
		const candidate = usage[field];
		return typeof candidate === "number" && Number.isFinite(candidate)
			? candidate
			: 0;
	};
	return {
		input_tokens: getNumber("input_tokens"),
		output_tokens: getNumber("output_tokens"),
		cache_read_input_tokens: getNumber("cache_read_input_tokens"),
		cache_creation_input_tokens: getNumber("cache_creation_input_tokens"),
	};
};

// Default model mapping: Anthropic model name prefixes → Codex model names
const DEFAULT_MODEL_MAP: Record<string, string> = {
	opus: "gpt-5.3-codex",
	sonnet: "gpt-5.3-codex",
	haiku: "gpt-5.4-mini",
};

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-5.3-codex": 272_000,
	"gpt-5.4": 272_000,
	"gpt-5.4-mini": 272_000,
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
	stream: boolean;
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
	reasoning?: { effort?: string };
	[key: string]: unknown;
}

// ── SSE streaming state ───────────────────────────────────────────────────────

interface FunctionCallBuffer {
	contentBlockIndex: number;
	arguments: string[];
}

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
	model: string;
	contentBlockIndex: number;
	hasSentMessageStart: boolean;
	hasSentContentBlockStart: boolean;
	hasSentTerminalEvents: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	contextWindow: ContextWindow | null;
	// Track function_call items: output_index → buffered arguments and block index
	functionCallBlocks: Map<number, FunctionCallBuffer>;
}

export class CodexProvider extends BaseProvider {
	name = "codex";
	// Fallback map: proxy-operations.ts injects x-better-ccflare-request-id and
	// x-better-ccflare-request-stream into the upstream response before calling
	// processResponse, so headerRequestedStream is normally set. This map covers
	// the race where a response arrives after the 30s TTL sweep evicts the entry.
	private requestStreamById = new Map<
		string,
		{ stream: boolean; ts: number }
	>();

	private sweepRequestStreamById(): void {
		const cutoff = Date.now() - 30_000;
		for (const [id, entry] of this.requestStreamById) {
			if (entry.ts < cutoff) {
				this.requestStreamById.delete(id);
			}
		}
	}

	canHandle(path: string): boolean {
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
		return CODEX_DEFAULT_ENDPOINT;
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
			this.sweepRequestStreamById();
			const body = (await request.json()) as AnthropicRequest;
			const requestId = request.headers.get("x-better-ccflare-request-id");
			if (requestId) {
				this.requestStreamById.set(requestId, {
					stream: body.stream === true,
					ts: Date.now(),
				});
			}
			const codexBody = this.convertToCodexFormat(
				body,
				account,
				requestId ?? undefined,
			);

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.set(
				"x-better-ccflare-request-stream",
				body.stream === true ? "true" : "false",
			);
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(codexBody),
			});
		} catch (error) {
			if (error instanceof ValidationError) {
				throw error;
			}
			log.error("Failed to transform request body to Codex format:", error);
			return request;
		}
	}

	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		const contentType = response.headers.get("content-type");
		const requestId = response.headers.get("x-better-ccflare-request-id");
		const headerRequestedStream = response.headers.get(
			"x-better-ccflare-request-stream",
		);
		const requestedStream =
			headerRequestedStream === "true"
				? true
				: headerRequestedStream === "false"
					? false
					: requestId
						? (this.requestStreamById.get(requestId)?.stream ?? true)
						: true;
		if (requestId) {
			this.requestStreamById.delete(requestId);
		}
		const isEventStream = contentType?.includes("text/event-stream") ?? false;
		if (isEventStream) {
			if (requestedStream) {
				return this.transformStreamingResponse(response);
			}
			return this.transformSseResponseToJson(response);
		}

		if (response.ok && response.body !== null) {
			const probeText = await response.text();
			const trimmed = probeText.trimStart();
			const isSseLike = trimmed.startsWith("event:");

			if (isSseLike) {
				log.warn(
					`Codex returned successful response without SSE content-type (${contentType ?? "<missing>"}); transforming as ${requestedStream ? "SSE" : "JSON"}`,
				);
				const headers = sanitizeResponseHeaders(response.headers);
				headers.set("content-type", "text/event-stream");
				const sseResponse = new Response(probeText, {
					status: response.status,
					statusText: response.statusText,
					headers,
				});
				if (requestedStream) {
					return this.transformStreamingResponse(sseResponse);
				}
				return this.transformSseResponseToJson(sseResponse);
			}

			const headers = sanitizeResponseHeaders(response.headers);
			return new Response(probeText, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		const headers = sanitizeResponseHeaders(response.headers);
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
		if (account) {
			const mapped = mapModelName(anthropicModel, account);
			if (mapped !== anthropicModel) {
				return mapped;
			}
		}

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
		const model = response?.model;
		if (typeof model !== "string") return null;
		const contextWindowSize = MODEL_CONTEXT_WINDOWS[model];
		if (!contextWindowSize) return null;

		const inputTokens = usage?.input_tokens;
		if (
			typeof inputTokens !== "number" ||
			!Number.isFinite(inputTokens) ||
			inputTokens < 0
		)
			return null;

		const usageRecord = usage as Record<string, unknown> | undefined;
		const inputTokenDetails = usageRecord?.input_tokens_details as
			| Record<string, unknown>
			| undefined;
		const cachedTokens = inputTokenDetails?.cached_tokens;

		return {
			current_usage: {
				input_tokens: inputTokens,
				cache_read_input_tokens:
					typeof cachedTokens === "number" &&
					Number.isFinite(cachedTokens) &&
					cachedTokens >= 0
						? cachedTokens
						: 0,
				cache_creation_input_tokens:
					typeof inputTokenDetails?.cache_creation_input_tokens === "number" &&
					Number.isFinite(inputTokenDetails.cache_creation_input_tokens) &&
					inputTokenDetails.cache_creation_input_tokens >= 0
						? inputTokenDetails.cache_creation_input_tokens
						: 0,
			},
			context_window_size: contextWindowSize,
		};
	}

	private convertToCodexFormat(
		body: AnthropicRequest,
		account?: Account,
		requestId?: string,
	): CodexRequest {
		const model = this.mapModel(body.model, account);
		if (process.env.DEBUG?.includes("model") || process.env.DEBUG === "true") {
			log.info(
				`[codex:model-debug] request_id=${requestId ?? "unknown"} request_model=${body.model} mapped_model=${model} account=${account?.name ?? "unknown"}`,
			);
		}
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

		const reasoningResolution = resolveReasoningEffort(body.reasoning?.effort, {
			sourceModel: body.model,
			targetModel: model,
		});
		if (reasoningResolution.downgrades.length > 0) {
			for (const downgrade of reasoningResolution.downgrades) {
				log.warn(
					`Downgraded reasoning effort for model ${downgrade.model}: ${downgrade.from} -> ${downgrade.to}`,
				);
			}
		}

		// Codex always requires streaming upstream; non-streaming clients are handled
		// on the response side via transformSseResponseToJson.
		const codexRequest: CodexRequest = {
			model,
			input,
			stream: true,
			store: false,
			reasoning: { effort: reasoningResolution.effort ?? "medium" },
		};

		codexRequest.instructions = instructions || "You are a helpful assistant.";
		if (tools) {
			codexRequest.tools = tools;
		}

		return codexRequest;
	}

	private async transformSseResponseToJson(
		response: Response,
	): Promise<Response> {
		const requestId =
			response.headers.get("x-better-ccflare-request-id") ?? "unknown";
		const transformed = this.transformStreamingResponse(response);
		const reader = transformed.body
			?.pipeThrough(new TextDecoderStream())
			.getReader();
		let messageStartPayload: Record<string, unknown> | null = null;
		let messageDeltaPayload: Record<string, unknown> | null = null;
		const content: Array<Record<string, unknown>> = [];
		const textByIndex = new Map<number, string>();
		const toolByIndex = new Map<
			number,
			{ id: string; name: string; partialJson: string }
		>();

		// Parse SSE line-pairs incrementally without buffering full body
		let pending = "";
		let lastEventName: string | null = null;
		const processLine = (line: string) => {
			if (line.startsWith("event:")) {
				lastEventName = line.slice("event:".length).trim();
			} else if (line.startsWith("data:") && lastEventName !== null) {
				const eventName = lastEventName;
				lastEventName = null;
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(line.slice("data:".length).trim());
				} catch {
					return;
				}
				if (eventName === "message_start") {
					messageStartPayload = data;
					return;
				}
				if (eventName === "message_delta") {
					messageDeltaPayload = data;
					return;
				}
				if (eventName === "content_block_delta") {
					const index = typeof data.index === "number" ? data.index : -1;
					const delta = data.delta as Record<string, unknown> | undefined;
					if (index < 0 || !delta) return;
					if (delta.type === "text_delta" && typeof delta.text === "string") {
						textByIndex.set(index, (textByIndex.get(index) ?? "") + delta.text);
					} else if (
						delta.type === "input_json_delta" &&
						typeof delta.partial_json === "string"
					) {
						const existing = toolByIndex.get(index);
						if (existing) {
							existing.partialJson += delta.partial_json;
						} else {
							toolByIndex.set(index, {
								id: "",
								name: "",
								partialJson: delta.partial_json,
							});
						}
					}
					return;
				}
				if (eventName === "content_block_start") {
					const index = typeof data.index === "number" ? data.index : -1;
					const block = data.content_block as
						| Record<string, unknown>
						| undefined;
					if (index < 0 || !block) return;
					if (block.type === "tool_use") {
						toolByIndex.set(index, {
							id: typeof block.id === "string" ? block.id : "",
							name: typeof block.name === "string" ? block.name : "",
							partialJson: toolByIndex.get(index)?.partialJson ?? "",
						});
					}
				}
			}
		};

		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					pending += value;
					const parts = pending.split("\n");
					pending = parts.pop() ?? "";
					for (const line of parts) {
						processLine(line);
					}
				}
				if (pending) processLine(pending);
			} finally {
				reader.releaseLock();
			}
		}

		const allIndices = new Set([...textByIndex.keys(), ...toolByIndex.keys()]);
		for (const index of [...allIndices].sort((a, b) => a - b)) {
			const text = textByIndex.get(index);
			if (text !== undefined) {
				content.push({ type: "text", text });
			}
			const tool = toolByIndex.get(index);
			if (tool !== undefined) {
				let input: Record<string, unknown> = {};
				if (tool.partialJson.trim().length > 0) {
					try {
						input = JSON.parse(tool.partialJson) as Record<string, unknown>;
					} catch {
						input = {};
					}
				}
				content.push({
					type: "tool_use",
					id: tool.id || `call_${index}`,
					name: tool.name,
					input,
				});
			}
		}
		const startMessage =
			((messageStartPayload as Record<string, unknown> | null)?.message as
				| Record<string, unknown>
				| undefined) ?? {};
		const hasDeltaUsage = messageDeltaPayload !== null;
		const deltaUsage = _normalizeUsage(
			(messageDeltaPayload as Record<string, unknown> | null)?.usage,
		);
		const startUsage = _normalizeUsage(startMessage.usage);
		const usage = {
			input_tokens: hasDeltaUsage
				? deltaUsage.input_tokens
				: startUsage.input_tokens,
			output_tokens: hasDeltaUsage
				? deltaUsage.output_tokens
				: startUsage.output_tokens,
			cache_read_input_tokens: hasDeltaUsage
				? deltaUsage.cache_read_input_tokens
				: startUsage.cache_read_input_tokens,
			cache_creation_input_tokens: hasDeltaUsage
				? deltaUsage.cache_creation_input_tokens
				: startUsage.cache_creation_input_tokens,
		};
		const resolvedModel =
			typeof startMessage.model === "string" ? startMessage.model : "gpt-5.4";
		if (
			resolvedModel === "gpt-5.4" &&
			(process.env.DEBUG?.includes("model") || process.env.DEBUG === "true")
		) {
			log.info(
				`[codex:model-debug] request_id=${requestId} transformSseResponseToJson used fallback model=gpt-5.4 (startMessage.model missing)`,
			);
		}
		const jsonPayload = {
			id:
				typeof startMessage.id === "string"
					? startMessage.id
					: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
			type: "message",
			role: "assistant",
			model: resolvedModel,
			content: content.length > 0 ? content : [{ type: "text", text: "" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage,
		};
		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "application/json");
		return new Response(JSON.stringify(jsonPayload), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	private transformStreamingResponse(response: Response): Response {
		const requestId =
			response.headers.get("x-better-ccflare-request-id") ?? "unknown";
		if (process.env.DEBUG?.includes("model") || process.env.DEBUG === "true") {
			log.info(
				`[codex:model-debug] request_id=${requestId} transformStreamingResponse initial fallback model=gpt-5.4 until response.created arrives`,
			);
		}
		const state: StreamState = {
			buffer: "",
			messageId: `msg_${crypto.randomUUID().replace(/-/g, "").substring(0, 24)}`,
			model: "gpt-5.4",
			contentBlockIndex: 0,
			hasSentMessageStart: false,
			hasSentContentBlockStart: false,
			hasSentTerminalEvents: false,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			contextWindow: null,
			functionCallBlocks: new Map(),
		};

		const headers = sanitizeResponseHeaders(response.headers);
		headers.set("content-type", "text/event-stream");

		const { readable, writable } = new TransformStream<
			Uint8Array,
			Uint8Array
		>();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const writeSSE = async (event: string, data: unknown) => {
			const payload =
				typeof data === "object" && data !== null
					? (data as Record<string, unknown>)
					: null;
			if ((event === "message_start" || event === "message_delta") && payload) {
				const normalizedUsage = _normalizeUsage(payload.usage);
				payload.usage = normalizedUsage;
				if (event === "message_start") {
					const message =
						typeof payload.message === "object" && payload.message !== null
							? (payload.message as Record<string, unknown>)
							: {};
					message.usage = _normalizeUsage(message.usage ?? normalizedUsage);
					payload.message = message;
				} else {
					const message = payload.message as
						| Record<string, unknown>
						| undefined;
					if (message) {
						message.usage = _normalizeUsage(message.usage ?? normalizedUsage);
					}
				}
			}
			if (event === "message_delta" && payload) {
				const delta =
					typeof payload.delta === "object" && payload.delta !== null
						? (payload.delta as Record<string, unknown>)
						: {};
				if (!("stop_reason" in delta)) {
					delta.stop_reason = "end_turn";
				}
				if (!("stop_sequence" in delta)) {
					delta.stop_sequence = null;
				}
				if (!("usage" in delta)) {
					delta.usage = payload.usage;
				}
				payload.delta = delta;
			}
			const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			await writer.write(encoder.encode(line));
		};
		const ensureMessageStart = async () => {
			if (state.hasSentMessageStart) return;
			state.hasSentMessageStart = true;
			await writeSSE("message_start", {
				type: "message_start",
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				message: {
					id: state.messageId,
					type: "message",
					role: "assistant",
					content: [],
					model: state.model,
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			});
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

						await this.handleCodexEvent(
							eventName,
							data,
							state,
							writeSSE,
							ensureMessageStart,
						);
					}
				}

				// Flush any remaining
				await ensureMessageStart();

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
		ensureMessageStart: () => Promise<void>,
	): Promise<void> {
		switch (eventName) {
			case "response.created": {
				const resp = data.response as Record<string, unknown> | undefined;
				const respId = (resp?.id as string) || state.messageId;
				state.messageId = respId;
				state.model = (resp?.model as string) || state.model;
				if (state.hasSentMessageStart) {
					break;
				}

				await ensureMessageStart();
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
					const callId = item?.call_id as string;
					const name = item?.name as string;

					if (state.hasSentContentBlockStart) {
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: state.contentBlockIndex,
						});
						state.contentBlockIndex++;
						state.hasSentContentBlockStart = false;
					}

					const blockIdx = state.contentBlockIndex;
					await ensureMessageStart();
					await writeSSE("content_block_start", {
						type: "content_block_start",
						index: blockIdx,
						content_block: { type: "tool_use", id: callId, name, input: {} },
					});
					state.hasSentContentBlockStart = true;
					if (outputIndex !== undefined) {
						state.functionCallBlocks.set(outputIndex, {
							contentBlockIndex: blockIdx,
							arguments: [],
						});
					}
				}
				break;
			}

			case "response.content_part.added": {
				const part = data.part as Record<string, unknown> | undefined;
				const partType = part?.type as string | undefined;

				if (partType === "output_text") {
					await ensureMessageStart();
					// Start a text content block
					if (state.hasSentContentBlockStart) {
						// Only close the current block if it's not a still-open function-call
						// block awaiting output_item.done — closing it here would produce a
						// premature content_block_stop that output_item.done will duplicate.
						const isOpenFunctionCallBlock = [
							...state.functionCallBlocks.values(),
						].some((b) => b.contentBlockIndex === state.contentBlockIndex);
						if (!isOpenFunctionCallBlock) {
							await writeSSE("content_block_stop", {
								type: "content_block_stop",
								index: state.contentBlockIndex,
							});
						}
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
					await ensureMessageStart();
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
				const outputIndex = data.output_index as number | undefined;
				if (delta && outputIndex !== undefined) {
					const buffer = state.functionCallBlocks.get(outputIndex);
					if (buffer) {
						buffer.arguments.push(delta);
					}
				}
				break;
			}

			case "response.output_item.done": {
				const item = data.item as Record<string, unknown> | undefined;
				const itemType = item?.type as string | undefined;

				if (itemType === "function_call") {
					const outputIndex = data.output_index as number | undefined;
					const buffer =
						outputIndex !== undefined
							? state.functionCallBlocks.get(outputIndex)
							: undefined;
					if (buffer) {
						await writeSSE("content_block_delta", {
							type: "content_block_delta",
							index: buffer.contentBlockIndex,
							delta: {
								type: "input_json_delta",
								partial_json: buffer.arguments.join(""),
							},
						});
						await writeSSE("content_block_stop", {
							type: "content_block_stop",
							index: buffer.contentBlockIndex,
						});
						if (outputIndex !== undefined) {
							state.functionCallBlocks.delete(outputIndex);
						}
						if (
							state.hasSentContentBlockStart &&
							state.contentBlockIndex === buffer.contentBlockIndex
						) {
							state.contentBlockIndex++;
							state.hasSentContentBlockStart = false;
						}
					}
					break;
				}

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
					| {
							input_tokens?: number;
							output_tokens?: number;
							input_tokens_details?: {
								cached_tokens?: number;
								cache_creation_input_tokens?: number;
							};
					  }
					| undefined;

				// Extract cache fields from input_tokens_details (Codex format)
				const inputTokenDetails = usage?.input_tokens_details;
				const cacheRead =
					typeof inputTokenDetails?.cached_tokens === "number" &&
					inputTokenDetails.cached_tokens >= 0
						? inputTokenDetails.cached_tokens
						: 0;
				const cacheCreation =
					typeof inputTokenDetails?.cache_creation_input_tokens === "number" &&
					inputTokenDetails.cache_creation_input_tokens >= 0
						? inputTokenDetails.cache_creation_input_tokens
						: 0;

				state.inputTokens = usage?.input_tokens || state.inputTokens;
				state.outputTokens = usage?.output_tokens || state.outputTokens;
				state.cacheReadInputTokens = cacheRead;
				state.cacheCreationInputTokens = cacheCreation;
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
					usage: {
						input_tokens: number;
						output_tokens: number;
						cache_read_input_tokens: number;
						cache_creation_input_tokens: number;
					};
					context_window?: ContextWindow;
				} = {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: {
						input_tokens: state.inputTokens,
						output_tokens: state.outputTokens,
						cache_read_input_tokens: state.cacheReadInputTokens,
						cache_creation_input_tokens: state.cacheCreationInputTokens,
					},
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
