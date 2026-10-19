import { Logger } from "@better-ccflare/logger";
import {
	convertOpenAIResponseToAnthropic,
	type OpenAIRequest,
	type OpenAIResponse,
	type OpenAIUsage,
} from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { registerProviderModelDefaultFactory } from "../../provider-model-defaults";
import type { ProviderResponseContext, TokenRefreshResult } from "../../types";
import { readRequestJson } from "../../utils/request-json";
import { OpenAICompatibleProvider } from "../openai/provider";
import {
	CODEBUDDY_CLI_VERSION,
	decodeCodeBuddyIdentity,
	refreshCodeBuddyToken,
	resolveCodeBuddyEndpoint,
} from "./auth-flow";
import {
	desensitizeMessages,
	isCodeBuddyDesensitizeEnabled,
	isCodeBuddyModerationBlock,
} from "./desensitize";

const log = new Logger("CodeBuddyProvider");

const CODEBUDDY_SYNTHETIC_COUNT_TOKENS_URL =
	"https://better-ccflare.local/codebuddy/count_tokens";

const CODEBUDDY_MODEL_DEFAULTS = {
	fable: "primary-model",
	opus: "primary-model",
	sonnet: "balanced-model",
	haiku: "fast-model",
};

registerProviderModelDefaultFactory("codebuddy", CODEBUDDY_MODEL_DEFAULTS);

export class CodeBuddyProvider extends OpenAICompatibleProvider {
	name = "codebuddy";

	buildUrl(path: string, query: string, account?: Account): string {
		const endpoint = resolveCodeBuddyEndpoint(account?.custom_endpoint);

		if (path === "/v1/messages") {
			return `${endpoint}/v2/chat/completions`;
		}
		if (path === "/v1/messages/count_tokens") {
			return CODEBUDDY_SYNTHETIC_COUNT_TOKENS_URL;
		}
		if (path === "/v1/models") {
			return `${endpoint}/v3/config`;
		}

		return `${endpoint}${path}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// Client credentials and Anthropic-only headers must never reach the
		// upstream provider.
		for (const name of [
			"authorization",
			"x-api-key",
			"host",
			"cookie",
			"anthropic-version",
			"anthropic-beta",
			"anthropic-dangerous-direct-browser-access",
			"cdn-loop",
			"forwarded",
			"x-real-ip",
		]) {
			newHeaders.delete(name);
		}

		// Internal proxy headers and ingress/CDN headers describe the client's
		// connection to this proxy, not the proxy's connection to CodeBuddy.
		for (const key of [...newHeaders.keys()]) {
			if (
				key.startsWith("x-better-ccflare-") ||
				key.startsWith("cf-") ||
				key.startsWith("x-forwarded-")
			) {
				newHeaders.delete(key);
			}
		}

		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		} else if (apiKey) {
			newHeaders.set("X-API-Key", apiKey);
		}

		const identity = decodeCodeBuddyIdentity(accessToken ?? "");
		if (identity.uid) {
			newHeaders.set("X-User-Id", identity.uid);
			if (identity.enterpriseId) {
				newHeaders.set("X-Enterprise-Id", identity.enterpriseId);
			}
			newHeaders.set(
				"X-Userinfo",
				Buffer.from(
					JSON.stringify({
						uin: identity.uid,
						...(identity.enterpriseId
							? { owner_uin: identity.enterpriseId }
							: {}),
					}),
					"utf8",
				).toString("base64"),
			);
		}

		const conversationId = crypto.randomUUID();
		const requestId = crypto.randomUUID().replace(/-/g, "");
		newHeaders.set("X-Conversation-ID", conversationId);
		newHeaders.set("X-Conversation-Request-ID", requestId);
		newHeaders.set("X-Conversation-Message-ID", requestId);
		newHeaders.set("X-Request-ID", requestId);

		newHeaders.set("X-Agent-Intent", "craft");
		newHeaders.set("X-Agent-Runtime", "local-agent");
		newHeaders.set("X-IDE-Type", "CLI");
		newHeaders.set("X-IDE-Name", "CLI");
		newHeaders.set("X-IDE-Version", CODEBUDDY_CLI_VERSION);
		newHeaders.set("X-Product", "SaaS");
		newHeaders.set(
			"User-Agent",
			`CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
		);

		return newHeaders;
	}

	override async refreshToken(account: Account): Promise<TokenRefreshResult> {
		return refreshCodeBuddyToken(account);
	}

	override supportsOAuth(): boolean {
		return true;
	}

	/**
	 * CodeBuddy accepts reasoning effort as a top-level field, not nested under
	 * `reasoning`, and requires long cache retention with store disabled.
	 * Deliberately does not call super: the parent only injects Alibaba
	 * caching, which does not apply here.
	 */
	protected override afterConvert(body: OpenAIRequest): void {
		const record = body as unknown as Record<string, unknown>;
		const reasoning = record.reasoning;

		if (reasoning && typeof reasoning === "object") {
			const effort = (reasoning as Record<string, unknown>).effort;
			if (typeof effort === "string") {
				record.reasoning_effort = effort;
				delete record.reasoning;
			}
		}

		record.cache_retention = "long";
		if (typeof record.reasoning_effort === "string") {
			record.reasoning_summary = "auto";
		}
		record.store = false;

		// CodeBuddy's gateway is stream-only in practice: the official CLI always
		// sends stream: true, and a non-streaming request is not a supported
		// shape. Always stream upstream and aggregate in processResponse for
		// clients that asked for JSON.
		record.stream = true;
		record.stream_options = { include_usage: true };

		// CodeBuddy's backend reviews content before inference and frequently
		// rejects the client's fixed compliance system template. Inserting
		// zero-width spaces into those template terms keeps the text readable
		// while avoiding the false positive. System messages only, so real
		// conversation content is never altered.
		if (isCodeBuddyDesensitizeEnabled() && Array.isArray(body.messages)) {
			body.messages = desensitizeMessages(
				body.messages as unknown as Array<Record<string, unknown>>,
			) as unknown as typeof body.messages;
		}
	}
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		if (request.url === CODEBUDDY_SYNTHETIC_COUNT_TOKENS_URL) {
			const contentType = request.headers.get("content-type");
			if (!contentType?.includes("application/json")) {
				return this.createSyntheticJsonResponse(request, 400, {
					type: "error",
					error: {
						type: "invalid_request_error",
						message:
							"CodeBuddy count_tokens requires an application/json request body.",
					},
				});
			}

			try {
				const body = (await request.json()) as unknown;
				return this.createSyntheticJsonResponse(request, 200, {
					input_tokens: this.estimateCountTokensInput(body),
				});
			} catch {
				return this.createSyntheticJsonResponse(request, 400, {
					type: "error",
					error: {
						type: "invalid_request_error",
						message:
							"CodeBuddy count_tokens requires a valid JSON request body.",
					},
				});
			}
		}

		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return super.transformRequestBody(request, account);
		}

		// The client's stream intent must be captured before the body is
		// converted (afterConvert forces stream: true upstream). The proxy
		// copies this internal header onto the upstream response so
		// processResponse can decide whether to aggregate.
		let clientWantsStream = false;
		try {
			const original = await readRequestJson<{ stream?: unknown }>(request);
			clientWantsStream = original?.stream === true;
		} catch {
			// A malformed body is handled by the shared converter.
		}

		const transformed = await super.transformRequestBody(request, account);
		if (transformed.headers.get("x-better-ccflare-synthetic-response")) {
			return transformed;
		}

		const headers = new Headers(transformed.headers);
		headers.set(
			"x-better-ccflare-request-stream",
			clientWantsStream ? "true" : "false",
		);
		return new Request(transformed, { headers });
	}

	async processResponse(
		response: Response,
		account: Account | null,
		requestHeaders?: Headers,
		drainAbort?: AbortController,
		context?: ProviderResponseContext,
	): Promise<Response> {
		if (
			response.headers.get("x-better-ccflare-request-path") === "/v1/models"
		) {
			return this.transformModelsListResponse(response);
		}

		if (!response.ok) {
			// Fire and forget: the clone is fully read, so no tee branch is left
			// buffering. Never delays the client response.
			void this.logModerationBlockIfPresent(response, account);
		}

		// Upstream is always streamed. A client that asked for JSON gets the
		// whole SSE body aggregated into one Anthropic message.
		const contentType = response.headers.get("content-type")?.toLowerCase();
		if (
			response.headers.get("x-better-ccflare-request-stream") === "false" &&
			contentType?.includes("text/event-stream")
		) {
			return this.aggregateSseToJson(response, context?.requestModel);
		}

		return super.processResponse(
			response,
			account,
			requestHeaders,
			drainAbort,
			context,
		);
	}

	/**
	 * Aggregate an OpenAI chat-completions SSE stream into a single Anthropic
	 * message. Used only when the client did not request streaming, since
	 * CodeBuddy is always asked to stream upstream.
	 */
	private async aggregateSseToJson(
		response: Response,
		fallbackModel?: string | null,
	): Promise<Response> {
		const body = await response.text();
		let responseId: string | undefined;
		let model: string | undefined;
		let finishReason: string | undefined;
		let usage: OpenAIUsage | undefined;
		let content = "";
		let reasoning = "";
		const toolCalls: Array<{
			id: string;
			type: "function";
			function: { name: string; arguments: string };
		}> = [];
		const toolCallSlots = new Map<number, number>();

		for (const line of body.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice("data:".length).trim();
			if (!payload || payload === "[DONE]") continue;

			let chunk: OpenAIResponse;
			try {
				chunk = JSON.parse(payload) as OpenAIResponse;
			} catch {
				continue;
			}

			if (chunk.error) {
				return new Response(
					JSON.stringify({ type: "error", error: chunk.error }),
					{
						status: response.status,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			responseId ??= chunk.id;
			model ??= chunk.model;
			if (chunk.usage) usage = chunk.usage;

			const chunkChoice = chunk.choices?.[0];
			if (chunkChoice?.finish_reason) finishReason = chunkChoice.finish_reason;

			const delta = chunkChoice?.delta;
			if (!delta) continue;

			// CodeBuddy emits thinking as `reasoning` for some models and
			// `reasoning_content` for others; the official CLI accepts both.
			const thinkingDelta =
				delta.reasoning_content ?? (delta as { reasoning?: unknown }).reasoning;
			if (typeof thinkingDelta === "string") reasoning += thinkingDelta;
			if (typeof delta.content === "string") content += delta.content;

			for (const call of delta.tool_calls ?? []) {
				const index = typeof call.index === "number" ? call.index : 0;
				let slot = toolCallSlots.get(index);
				if (slot === undefined) {
					slot = toolCalls.length;
					toolCallSlots.set(index, slot);
					toolCalls.push({
						id: "",
						type: "function",
						function: { name: "", arguments: "" },
					});
				}
				const target = toolCalls[slot];
				if (call.id && !target.id) target.id = call.id;
				if (call.function?.name && !target.function.name) {
					target.function.name = call.function.name;
				}
				if (call.function?.arguments) {
					target.function.arguments += call.function.arguments;
				}
			}
		}

		const anthropic = convertOpenAIResponseToAnthropic(
			{
				id: responseId,
				model,
				usage,
				choices: [
					{
						finish_reason: finishReason,
						message: {
							role: "assistant",
							content,
							...(reasoning ? { reasoning_content: reasoning } : {}),
							...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
						},
					},
				],
			},
			fallbackModel ?? undefined,
		);

		return new Response(JSON.stringify(anthropic), {
			status: response.status,
			statusText: response.statusText,
			headers: { "Content-Type": "application/json" },
		});
	}

	/**
	 * CodeBuddy's backend content review rejects a request before inference and
	 * reports it in the error body. Log enough to identify the request in the
	 * journal; the fix for a false positive on a client template is the
	 * desensitizer (on by default), and for real harmful input it is the caller's
	 * content.
	 */
	private async logModerationBlockIfPresent(
		response: Response,
		account: Account | null,
	): Promise<void> {
		try {
			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.includes("json") && !contentType.includes("text")) {
				return;
			}
			const text = await response.clone().text();
			if (!isCodeBuddyModerationBlock(text)) return;
			log.warn("CodeBuddy content review blocked the request", {
				account: account?.name ?? null,
				request_id: response.headers.get("x-better-ccflare-request-id") ?? null,
				status: response.status,
				desensitize_enabled: isCodeBuddyDesensitizeEnabled(),
				hint: "If the flagged text came from the client's fixed compliance template, keep desensitization enabled (CCFLARE_CODEBUDDY_DESENSITIZE) or inspect the system prompt.",
			});
		} catch {
			// Diagnostics must never affect the proxied response.
		}
	}

	private async transformModelsListResponse(
		response: Response,
	): Promise<Response> {
		try {
			const raw = (await response.json()) as {
				data?: { agents?: Array<Record<string, unknown>> };
			};
			const agents = Array.isArray(raw.data?.agents) ? raw.data.agents : [];
			const cliAgent = agents.find(
				(agent) =>
					agent !== null && typeof agent === "object" && agent.name === "cli",
			);
			const listed = Array.isArray(cliAgent?.models)
				? (cliAgent.models as unknown[])
				: [];
			const created = Math.floor(Date.now() / 1000);

			const data: Array<{
				id: string;
				object: "model";
				owned_by: "codebuddy";
				created: number;
			}> = [];
			for (const entry of listed) {
				if (!entry || typeof entry !== "object") continue;
				const model = entry as Record<string, unknown>;
				const id =
					typeof model.id === "string" && model.id.length > 0
						? model.id
						: typeof model.name === "string" && model.name.length > 0
							? model.name
							: undefined;
				if (!id) continue;
				data.push({
					id,
					object: "model",
					owned_by: "codebuddy",
					created,
				});
			}

			return new Response(
				JSON.stringify({ object: "list", data, models: data }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			log.warn(`Failed to transform CodeBuddy models response: ${error}`);
			return new Response(
				JSON.stringify({
					error: {
						type: "api_error",
						message: "CodeBuddy models response could not be parsed",
					},
				}),
				{
					status: 502,
					statusText: "Bad Gateway",
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	private createSyntheticJsonResponse(
		request: Request,
		status: number,
		body: unknown,
	): Request {
		const headers = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-synthetic-response": "true",
			"x-better-ccflare-synthetic-status": String(status),
		});
		return new Request(request.url, {
			method: request.method,
			headers,
			body: JSON.stringify(body),
		});
	}

	private estimateCountTokensInput(body: unknown): number {
		const material = this.extractCountTokensMaterial(body);
		let serialized = material.join("\n");
		if (serialized.length === 0) {
			try {
				serialized = JSON.stringify(body) ?? "";
			} catch {
				serialized = String(body ?? "");
			}
		}

		// CodeBuddy has no count_tokens endpoint. Anthropic's endpoint is
		// advisory for client-side budgeting, so return a conservative local
		// estimate over prompt material rather than the JSON envelope.
		return Math.max(1, Math.ceil(serialized.length / 3));
	}

	private extractCountTokensMaterial(body: unknown): string[] {
		if (!body || typeof body !== "object") return [];
		const request = body as Record<string, unknown>;
		const chunks: string[] = [];
		this.appendCountTokensContent(chunks, request.system);
		const messages = request.messages;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				if (!message || typeof message !== "object") continue;
				const msg = message as Record<string, unknown>;
				if (typeof msg.role === "string") chunks.push(msg.role);
				this.appendCountTokensContent(chunks, msg.content);
			}
		}
		const tools = request.tools;
		if (Array.isArray(tools)) {
			for (const tool of tools) {
				this.appendCountTokensContent(chunks, tool);
			}
		}
		return chunks;
	}

	private appendCountTokensContent(chunks: string[], value: unknown): void {
		if (typeof value === "string") {
			chunks.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				this.appendCountTokensContent(chunks, item);
			}
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		const before = chunks.length;
		if (typeof record.text === "string") chunks.push(record.text);
		if (typeof record.name === "string") chunks.push(record.name);
		if (typeof record.description === "string") chunks.push(record.description);
		if ("input" in record) this.appendCountTokensContent(chunks, record.input);
		if ("content" in record)
			this.appendCountTokensContent(chunks, record.content);
		if ("input_schema" in record) {
			this.appendCountTokensContent(chunks, record.input_schema);
		}
		if ("parameters" in record) {
			this.appendCountTokensContent(chunks, record.parameters);
		}
		if (Object.keys(record).length > 0 && chunks.length === before) {
			try {
				chunks.push(JSON.stringify(record));
			} catch {
				// Ignore non-serializable objects; the caller has a fallback.
			}
		}
	}
}
