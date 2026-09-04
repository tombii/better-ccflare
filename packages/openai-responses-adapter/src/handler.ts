import crypto from "node:crypto";
import { Logger } from "@better-ccflare/logger";
import { translateRequestToAnthropic } from "./request-translator";
import { translateAnthropicResponseToResponses } from "./response-translator";
import { translateAnthropicStreamToResponses } from "./stream-translator";
import type { HandleProxyFn, ResponseItem, ResponsesRequest } from "./types";

const log = new Logger("openai-responses-adapter");

const TERMINAL_RESPONSE_EVENT_TYPES = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

const NATIVE_RESPONSES_HEADER = "x-better-ccflare-native-responses";
const LANETALLY_CONTINUATION_HEADER = "x-lanetally-codex-continuation";
const LANETALLY_CACHE_MODE_HEADER = "x-lanetally-prompt-cache-mode";
const LANETALLY_CACHE_TTL_HEADER = "x-lanetally-prompt-cache-ttl";
const LANETALLY_CACHE_BREAKPOINT_HEADER = "x-lanetally-prompt-cache-breakpoint";
const MAX_PROMPT_CACHE_BREAKPOINTS = 4;

type CacheDiagnostic = {
	type?: string;
	reason?: string;
	cache_missed_tokens?: number;
	comparison_reusable_tokens?: number;
};

function countPromptCacheBreakpoints(value: unknown): number {
	if (Array.isArray(value)) {
		return value.reduce(
			(total, item) => total + countPromptCacheBreakpoints(item),
			0,
		);
	}
	if (!value || typeof value !== "object") return 0;
	const record = value as Record<string, unknown>;
	let total = Object.hasOwn(record, "prompt_cache_breakpoint") ? 1 : 0;
	for (const [key, child] of Object.entries(record)) {
		if (key !== "prompt_cache_breakpoint") {
			total += countPromptCacheBreakpoints(child);
		}
	}
	return total;
}

function addDeveloperBreakpoint(body: ResponsesRequest): ResponsesRequest {
	if (!Array.isArray(body.input)) {
		throw new Error("developer cache breakpoint requires array input");
	}
	const input = structuredClone(body.input);
	const existingCount = countPromptCacheBreakpoints(input);
	for (let itemIndex = input.length - 1; itemIndex >= 0; itemIndex--) {
		const item = input[itemIndex] as unknown as Record<string, unknown>;
		// The pinned generic pi Responses adapter emits the system prompt as
		// `{ role: "developer", content: "..." }` (without `type: "message"`).
		// Accept both that shape and the fully typed Responses item.
		if (
			(item.type !== undefined && item.type !== "message") ||
			item.role !== "developer"
		) {
			continue;
		}
		const content = item.content;
		if (typeof content === "string") {
			if (existingCount >= MAX_PROMPT_CACHE_BREAKPOINTS) {
				throw new Error("developer cache breakpoint budget is exhausted");
			}
			item.type ??= "message";
			item.content = [
				{
					type: "input_text",
					text: content,
					prompt_cache_breakpoint: { mode: "explicit" },
				},
			];
			return { ...body, input } as ResponsesRequest;
		}
		if (!Array.isArray(content)) continue;
		for (
			let contentIndex = content.length - 1;
			contentIndex >= 0;
			contentIndex--
		) {
			const block = content[contentIndex];
			if (
				block &&
				typeof block === "object" &&
				((block as Record<string, unknown>).type === "input_text" ||
					(block as Record<string, unknown>).type === "output_text")
			) {
				const target = block as Record<string, unknown>;
				if (
					!Object.hasOwn(target, "prompt_cache_breakpoint") &&
					existingCount >= MAX_PROMPT_CACHE_BREAKPOINTS
				) {
					throw new Error("developer cache breakpoint budget is exhausted");
				}
				target.prompt_cache_breakpoint ??= {
					mode: "explicit",
				};
				return { ...body, input } as ResponsesRequest;
			}
		}
	}
	throw new Error("developer cache breakpoint boundary was not found");
}

function applyLaneTallyCacheControls(
	body: ResponsesRequest,
	headers: Headers,
): ResponsesRequest {
	let controlled = body;
	const mode = headers.get(LANETALLY_CACHE_MODE_HEADER)?.toLowerCase();
	const ttl = headers.get(LANETALLY_CACHE_TTL_HEADER)?.toLowerCase();
	const suppliedOptions = controlled.prompt_cache_options as
		| {
				mode?: string;
				ttl?: "30m";
				comparison_response_id?: string;
		  }
		| undefined;
	if (
		mode === "implicit" ||
		mode === "explicit" ||
		ttl === "30m" ||
		suppliedOptions?.mode === "implicit"
	) {
		const options = { ...(suppliedOptions ?? {}) };
		// Some clients serialize the conceptual default as `implicit`, but the
		// wire schema only accepts `explicit`; normalize it even without a route
		// override so the proxy never forwards an invalid enum value.
		if (options.mode === "implicit") delete options.mode;
		if (mode === "implicit") {
			// The API's only explicit enum value is `explicit`; implicit is the
			// default and must be expressed by omitting the mode property.
			delete options.mode;
		} else if (mode === "explicit") {
			options.mode = "explicit";
		}
		if (ttl === "30m") options.ttl = "30m";
		controlled = {
			...controlled,
			prompt_cache_options: options as ResponsesRequest["prompt_cache_options"],
		};
	}
	if (
		headers.get(LANETALLY_CACHE_BREAKPOINT_HEADER)?.toLowerCase() ===
		"developer"
	) {
		controlled = addDeveloperBreakpoint(controlled);
	}
	return controlled;
}

function logCacheRequestDiagnostics(body: ResponsesRequest, headers: Headers) {
	log.info("Codex cache request diagnostics", {
		transportRequested: body.stream === true ? "sse" : "http",
		previousResponseRequested:
			typeof body.previous_response_id === "string" &&
			body.previous_response_id.length > 0,
		continuationStrategy:
			headers.get(LANETALLY_CONTINUATION_HEADER) === "previous_response_id"
				? "previous_response_id"
				: "none",
		cacheMode: body.prompt_cache_options?.mode ?? "implicit",
		cacheTtl: body.prompt_cache_options?.ttl ?? "default",
		breakpointCount: countPromptCacheBreakpoints(body.input),
		comparisonResponseIdPresent:
			typeof body.prompt_cache_options?.comparison_response_id === "string" &&
			body.prompt_cache_options.comparison_response_id.length > 0,
	});
}

function logCacheCallerDiagnostics(apiKeyId?: string | null): void {
	log.info("Codex cache caller diagnostics", {
		authenticatedCallerPresent:
			typeof apiKeyId === "string" && apiKeyId.length > 0,
	});
}

function logCacheResponseDiagnostics(response: Record<string, unknown>): void {
	const diagnostics = response.prompt_cache_diagnostics as
		| CacheDiagnostic
		| undefined;
	if (!diagnostics || typeof diagnostics !== "object") return;
	log.info("Codex cache response diagnostics", {
		type: typeof diagnostics.type === "string" ? diagnostics.type : "unknown",
		reason:
			typeof diagnostics.reason === "string" ? diagnostics.reason : "unknown",
		cacheMissedTokens:
			typeof diagnostics.cache_missed_tokens === "number"
				? diagnostics.cache_missed_tokens
				: null,
		comparisonReusableTokens:
			typeof diagnostics.comparison_reusable_tokens === "number"
				? diagnostics.comparison_reusable_tokens
				: null,
	});
}

function inspectNativeResponsesStream(
	body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
	if (!body) return null;
	const decoder = new TextDecoder();
	let pending = "";
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(chunk);
				pending += decoder.decode(chunk, { stream: true });
				const events = pending.split(/\r?\n\r?\n/);
				pending = events.pop() ?? "";
				for (const event of events) {
					const terminal = extractTerminalNativeResponse(`${event}\n\n`);
					if (terminal) logCacheResponseDiagnostics(terminal);
				}
			},
			flush() {
				pending += decoder.decode();
				const terminal = extractTerminalNativeResponse(pending);
				if (terminal) logCacheResponseDiagnostics(terminal);
			},
		}),
	);
}

function extractTerminalNativeResponse(
	sseText: string,
): Record<string, unknown> | null {
	const rawEvents = sseText.split(/\r?\n\r?\n/);
	for (let i = rawEvents.length - 1; i >= 0; i--) {
		const rawEvent = rawEvents[i];
		if (!rawEvent.trim()) continue;

		let eventType = "";
		const dataLines: string[] = [];
		for (const line of rawEvent.split(/\r?\n/)) {
			if (line.startsWith("event:")) {
				eventType = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				const value = line.slice("data:".length);
				dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
			}
		}
		const dataStr = dataLines.join("\n");
		if (!dataStr) continue;

		try {
			const data = JSON.parse(dataStr) as {
				type?: string;
				response?: Record<string, unknown>;
			};
			const type = data.type ?? eventType;
			if (type && TERMINAL_RESPONSE_EVENT_TYPES.has(type) && data.response) {
				return data.response;
			}
		} catch {
			// Malformed event — keep scanning earlier events.
		}
	}
	return null;
}

export async function handleResponsesRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	// 1. Parse body — Codex CLI compresses request bodies (zstd, gzip, deflate).
	// Bun decompresses response bodies automatically but not request bodies,
	// so we decompress manually when content-encoding is present.
	let rawBody = await req.arrayBuffer();
	const contentEncoding = req.headers.get("content-encoding")?.toLowerCase();
	if (contentEncoding) {
		try {
			const bytes = new Uint8Array(rawBody);
			let decompressed: Uint8Array;
			if (contentEncoding === "zstd") {
				decompressed = Bun.zstdDecompressSync(bytes);
			} else if (contentEncoding === "gzip") {
				decompressed = Bun.gunzipSync(bytes);
			} else if (contentEncoding === "deflate") {
				decompressed = Bun.inflateSync(bytes);
			} else {
				log.warn(`Unsupported content-encoding: ${contentEncoding}`);
				decompressed = bytes;
			}
			rawBody = decompressed.buffer as ArrayBuffer;
		} catch (e) {
			log.warn(`Failed to decompress ${contentEncoding} request body: ${e}`);
		}
	}

	let body: ResponsesRequest;
	try {
		body = JSON.parse(new TextDecoder().decode(rawBody)) as ResponsesRequest;
	} catch {
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "Invalid JSON body" },
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// 2. Validate & normalise `input` — OpenAI Responses API allows a plain string
	if (!body || (typeof body.input !== "string" && !Array.isArray(body.input))) {
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "input: Field required",
				},
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}
	if (typeof body.input === "string") {
		body = {
			...body,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: body.input }],
				},
			],
		};
	}
	try {
		body = applyLaneTallyCacheControls(body, req.headers);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "invalid cache controls";
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message },
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}
	logCacheRequestDiagnostics(body, req.headers);
	logCacheCallerDiagnostics(apiKeyId);

	// 3. Generate response ID
	const responseId = `resp_${crypto.randomBytes(12).toString("hex")}`;

	// 4. Translate to Anthropic format
	const anthropicBody = translateRequestToAnthropic(
		body as typeof body & { input: ResponseItem[] },
	);

	// 4b. Preserve the client's session identity. Codex CLI identifies its
	// conversation via prompt_cache_key (some versions also send a session_id
	// header); the translated Anthropic body would otherwise carry no
	// metadata, leaving this traffic anonymous to downstream per-session
	// accounting (session governor, load-balancer session affinity).
	const sessionKey =
		(typeof body.prompt_cache_key === "string" && body.prompt_cache_key) ||
		req.headers.get("session-id") ||
		req.headers.get("session_id") ||
		req.headers.get("x-session-id") ||
		req.headers.get("x-bf-eh-session-id") ||
		null;
	if (sessionKey && !anthropicBody.metadata) {
		anthropicBody.metadata = { user_id: `codex-responses-${sessionKey}` };
	}

	// 5. Build synthetic request targeting /v1/messages
	const messagesUrl = new URL(url.toString());
	messagesUrl.pathname = "/v1/messages";
	const syntheticHeaders = new Headers(req.headers);
	const forwardedSessionId =
		req.headers.get("session-id") ?? req.headers.get("x-bf-eh-session-id");
	const forwardedClientRequestId =
		req.headers.get("x-client-request-id") ??
		req.headers.get("x-bf-eh-x-client-request-id");
	if (forwardedSessionId)
		syntheticHeaders.set("session-id", forwardedSessionId);
	if (forwardedClientRequestId) {
		syntheticHeaders.set("x-client-request-id", forwardedClientRequestId);
	}
	syntheticHeaders.delete("x-bf-eh-session-id");
	syntheticHeaders.delete("x-bf-eh-x-client-request-id");
	syntheticHeaders.delete(LANETALLY_CONTINUATION_HEADER);
	syntheticHeaders.delete(LANETALLY_CACHE_MODE_HEADER);
	syntheticHeaders.delete(LANETALLY_CACHE_TTL_HEADER);
	syntheticHeaders.delete(LANETALLY_CACHE_BREAKPOINT_HEADER);
	syntheticHeaders.set(NATIVE_RESPONSES_HEADER, "true");
	syntheticHeaders.set("content-type", "application/json");
	syntheticHeaders.delete("content-length");
	// Body is now decompressed plain JSON — remove the original encoding hint.
	syntheticHeaders.delete("content-encoding");
	// Required by Anthropic API — Codex CLI doesn't send this header.
	if (!syntheticHeaders.has("anthropic-version")) {
		syntheticHeaders.set("anthropic-version", "2023-06-01");
	}
	// claude-oauth accounts use Claude's OAuth tokens — Anthropic bans them
	// when used outside Claude CLI. Always exclude from Codex CLI traffic.
	syntheticHeaders.set("x-better-ccflare-exclude-providers", "anthropic-oauth");
	// Preserve Codex-only fields.
	const codexPassthrough: Record<string, unknown> = {};
	if (typeof apiKeyId === "string" && apiKeyId.length > 0) {
		// Bind gateway-managed continuation to the authenticated front-door key
		// without retaining or forwarding the key record ID itself.
		codexPassthrough.caller_identity_digest = crypto
			.createHash("sha256")
			.update("better-ccflare:caller-api-key:v1\0")
			.update(apiKeyId)
			.digest("hex");
	}
	if (body.model !== undefined) codexPassthrough.model = body.model;
	if (body.reasoning !== undefined) codexPassthrough.reasoning = body.reasoning;
	if (body.prompt_cache_key !== undefined)
		codexPassthrough.prompt_cache_key = body.prompt_cache_key;
	if (body.prompt_cache_options !== undefined)
		codexPassthrough.prompt_cache_options = body.prompt_cache_options;
	if (body.previous_response_id !== undefined)
		codexPassthrough.previous_response_id = body.previous_response_id;
	if (
		req.headers.get(LANETALLY_CONTINUATION_HEADER) === "previous_response_id"
	) {
		codexPassthrough.continuation_strategy = "previous_response_id";
	}
	// Preserve the native item structure for Codex accounts. This retains
	// content-level prompt_cache_breakpoint markers and makes incremental
	// previous_response_id requests lossless. Non-Codex failover still receives
	// the translated Anthropic messages; its generic model mapper strips this
	// provider-private side channel.
	codexPassthrough.native_input = body.input;
	if (body.instructions !== undefined)
		codexPassthrough.native_instructions = body.instructions;
	if (body.tools !== undefined) codexPassthrough.tools = body.tools;
	if (body.parallel_tool_calls !== undefined)
		codexPassthrough.parallel_tool_calls = body.parallel_tool_calls;
	if (body.store !== undefined) codexPassthrough.store = body.store;
	// Preserve Responses Lite tools.
	const additionalToolsItems = Array.isArray(body.input)
		? body.input.filter(
				(item) =>
					typeof item === "object" &&
					item !== null &&
					(item as unknown as Record<string, unknown>).type ===
						"additional_tools",
			)
		: [];
	if (additionalToolsItems.length > 0) {
		codexPassthrough.additional_tools = additionalToolsItems;
	}
	if (Object.keys(codexPassthrough).length > 0) {
		(
			anthropicBody as typeof anthropicBody & {
				__better_ccflare_codex_passthrough?: Record<string, unknown>;
			}
		).__better_ccflare_codex_passthrough = codexPassthrough;
	}
	const syntheticReq = new Request(messagesUrl.toString(), {
		method: "POST",
		headers: syntheticHeaders,
		body: JSON.stringify(anthropicBody),
		// Keep the client's disconnect wired to the upstream call: this request
		// is built from a URL, which does not inherit the signal.
		signal: req.signal,
	});

	// 6. Forward to proxy
	log.info(`Forwarding responses request to ${messagesUrl.pathname}`);
	let anthropicResp: Response;
	try {
		anthropicResp = await handleProxy(
			syntheticReq,
			messagesUrl,
			ctx,
			apiKeyId,
			apiKeyName,
			{ trustedNativeResponses: true },
		);
	} catch (err) {
		const statusCode =
			typeof err === "object" &&
			err !== null &&
			"statusCode" in err &&
			typeof (err as { statusCode: unknown }).statusCode === "number"
				? (err as { statusCode: number }).statusCode
				: 503;
		const isUnavailable = statusCode === 503;
		return new Response(
			JSON.stringify({
				error: {
					message: isUnavailable
						? "Service temporarily unavailable. Please try again later."
						: "Proxy request failed",
					type: isUnavailable ? "server_error" : "api_error",
					code: isUnavailable ? "server_error" : "api_error",
				},
			}),
			{ status: statusCode, headers: { "Content-Type": "application/json" } },
		);
	}

	// 7. Translate non-200 Anthropic errors to OpenAI error shape
	if (anthropicResp.status !== 200) {
		let errorBody: { error: { message: string; type: string; code: string } };
		const contentType = anthropicResp.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			try {
				const anthropicError = (await anthropicResp.json()) as {
					type?: string;
					error?: { type?: string; message?: string };
				};
				const errType = anthropicError?.error?.type ?? "api_error";
				errorBody = {
					error: {
						message: anthropicError?.error?.message ?? "Unknown error",
						type: errType,
						code: errType,
					},
				};
			} catch {
				errorBody = {
					error: {
						message: "Unknown error",
						type: "api_error",
						code: "api_error",
					},
				};
			}
		} else {
			errorBody = {
				error: {
					message: "Unknown error",
					type: "api_error",
					code: "api_error",
				},
			};
		}
		return new Response(JSON.stringify(errorBody), {
			status: anthropicResp.status,
			headers: (() => {
				const headers = new Headers(anthropicResp.headers);
				headers.delete("x-better-ccflare-codex-response-format");
				headers.set("content-type", "application/json");
				return headers;
			})(),
		});
	}

	// Set regardless of whether the original request streamed, so this check
	// must run before the body.stream branch below.
	const responseFormat = anthropicResp.headers.get(
		"x-better-ccflare-codex-response-format",
	);
	if (responseFormat === "responses-api") {
		if (body.stream) {
			const headers = new Headers(anthropicResp.headers);
			headers.delete("x-better-ccflare-codex-response-format");
			return new Response(inspectNativeResponsesStream(anthropicResp.body), {
				status: anthropicResp.status,
				headers,
			});
		}
		// Client expects a JSON body. Native providers may answer either JSON or
		// SSE even for a non-streaming caller; preserve JSON directly and unwrap
		// only an actually event-stream response.
		const responseText = await anthropicResp.text();
		const upstreamContentType =
			anthropicResp.headers.get("content-type")?.toLowerCase() ?? "";
		let nativeResponse: Record<string, unknown> | null = null;
		if (upstreamContentType.includes("text/event-stream")) {
			nativeResponse = extractTerminalNativeResponse(responseText);
		} else {
			try {
				nativeResponse = JSON.parse(responseText) as Record<string, unknown>;
			} catch {
				nativeResponse = null;
			}
		}
		if (!nativeResponse) {
			const headers = new Headers(anthropicResp.headers);
			headers.delete("x-better-ccflare-codex-response-format");
			headers.set("content-type", "application/json");
			return new Response(
				JSON.stringify({
					error: {
						message: "Failed to parse upstream response",
						type: "api_error",
						code: "api_error",
					},
				}),
				{ status: 502, headers },
			);
		}
		logCacheResponseDiagnostics(nativeResponse);
		const headers = new Headers(anthropicResp.headers);
		headers.delete("x-better-ccflare-codex-response-format");
		headers.set("content-type", "application/json");
		return new Response(JSON.stringify(nativeResponse), {
			status: 200,
			headers,
		});
	}

	// 8. Stream path
	if (body.stream) {
		return translateAnthropicStreamToResponses(
			anthropicResp,
			responseId,
			body.model,
		);
	}

	// 9. Non-stream path
	let respBody: unknown;
	try {
		respBody = await anthropicResp.json();
	} catch {
		return new Response(
			JSON.stringify({
				error: {
					message: "Failed to parse upstream response",
					type: "api_error",
					code: "api_error",
				},
			}),
			{ status: 502, headers: { "Content-Type": "application/json" } },
		);
	}
	const translated = translateAnthropicResponseToResponses(
		respBody as Parameters<typeof translateAnthropicResponseToResponses>[0],
		responseId,
		body.model,
	);
	return new Response(JSON.stringify(translated), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
