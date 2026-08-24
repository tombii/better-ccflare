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

function extractTerminalNativeResponse(
	sseText: string,
): Record<string, unknown> | null {
	const rawEvents = sseText.split("\n\n");
	for (let i = rawEvents.length - 1; i >= 0; i--) {
		const rawEvent = rawEvents[i];
		if (!rawEvent.trim()) continue;

		let eventType = "";
		let dataStr = "";
		for (const line of rawEvent.split("\n")) {
			if (line.startsWith("event:")) {
				eventType = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				dataStr = line.slice("data:".length).trim();
			}
		}
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

	// `previous_response_id` is intentionally ignored. Codex only sends this
	// field over its WebSocket path (see codex-rs/core/src/client.rs:get_incremental_items).
	// For regular HTTP /v1/responses requests Codex always includes the full
	// conversation history in `input`, so there is nothing to resolve here.

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
		req.headers.get("session_id") ||
		req.headers.get("x-session-id") ||
		null;
	if (sessionKey && !anthropicBody.metadata) {
		anthropicBody.metadata = { user_id: `codex-responses-${sessionKey}` };
	}

	// 5. Build synthetic request targeting /v1/messages
	const messagesUrl = new URL(url.toString());
	messagesUrl.pathname = "/v1/messages";
	const syntheticHeaders = new Headers(req.headers);
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
	if (body.model !== undefined) codexPassthrough.model = body.model;
	if (body.reasoning !== undefined) codexPassthrough.reasoning = body.reasoning;
	if (body.prompt_cache_key !== undefined)
		codexPassthrough.prompt_cache_key = body.prompt_cache_key;
	if (body.tools !== undefined) codexPassthrough.tools = body.tools;
	if (body.parallel_tool_calls !== undefined)
		codexPassthrough.parallel_tool_calls = body.parallel_tool_calls;
	if (body.store !== undefined) codexPassthrough.store = body.store;
	// Preserve Responses Lite tools.
	const additionalToolsItems = Array.isArray(body.input)
		? body.input.filter((item: any) => item.type === "additional_tools")
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
			headers: { "Content-Type": "application/json" },
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
			return new Response(anthropicResp.body, {
				status: anthropicResp.status,
				headers,
			});
		}
		// Client expects a JSON body, not SSE framing.
		const sseText = await anthropicResp.text();
		const nativeResponse = extractTerminalNativeResponse(sseText);
		if (!nativeResponse) {
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
		return new Response(JSON.stringify(nativeResponse), {
			status: 200,
			headers: { "Content-Type": "application/json" },
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
