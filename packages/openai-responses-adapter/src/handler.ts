import crypto from "node:crypto";
import { Logger } from "@better-ccflare/logger";
import {
	BETTER_CCFLARE_REQUEST_SOURCE_HEADER,
	CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV,
	CODEX_CLAUDE_OAUTH_ALLOWLIST_HEADER,
	CODEX_CLAUDE_OAUTH_MODE_COMPAT,
	CODEX_CLAUDE_OAUTH_MODE_ENV,
	CODEX_CLAUDE_OAUTH_MODE_HEADER,
	CODEX_CLAUDE_OAUTH_MODE_SAFE,
	CODEX_RESPONSES_REQUEST_SOURCE,
} from "@better-ccflare/types";
import { translateRequestToAnthropic } from "./request-translator";
import { translateAnthropicResponseToResponses } from "./response-translator";
import { translateAnthropicStreamToResponses } from "./stream-translator";
import type { HandleProxyFn, ResponseItem, ResponsesRequest } from "./types";

const log = new Logger("openai-responses-adapter");
const CLAUDE_CODE_COMPAT_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,token-efficient-tools-2026-03-28";
const CLAUDE_CODE_COMPAT_VERSION = "2.1.63";
const CLAUDE_CODE_COMPAT_FINGERPRINT_SALT = "59cf53e54c78";
const INTERNAL_REQUEST_HEADERS = [
	"x-better-ccflare-bypass-session",
	"x-better-ccflare-auto-refresh",
	"x-better-ccflare-keepalive",
];
const CLAUDE_CODE_COMPAT_PROMPT = [
	"You are Claude Code, Anthropic's official CLI for Claude.",
	"You help with code changes, debugging, and repo-aware development tasks.",
	"Be concise, direct, and action-oriented.",
].join("\n\n");

function parseCsv(value: string | undefined | null): string[] {
	return (
		value
			?.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean) ?? []
	);
}

function appendCsvHeader(headers: Headers, name: string, value: string): void {
	const values = new Set(parseCsv(headers.get(name)));
	values.add(value);
	headers.set(name, [...values].join(","));
}

function removeCsvHeaderValue(
	headers: Headers,
	name: string,
	value: string,
): void {
	const values = parseCsv(headers.get(name)).filter((entry) => entry !== value);
	if (values.length === 0) headers.delete(name);
	else headers.set(name, values.join(","));
}

function resolveCodexClaudeOauthPolicy(): {
	mode:
		| typeof CODEX_CLAUDE_OAUTH_MODE_SAFE
		| typeof CODEX_CLAUDE_OAUTH_MODE_COMPAT;
	allowlist: string[];
} {
	const requestedMode = process.env[CODEX_CLAUDE_OAUTH_MODE_ENV]?.trim();
	const allowlist = parseCsv(
		process.env[CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV],
	);
	if (
		requestedMode === CODEX_CLAUDE_OAUTH_MODE_COMPAT &&
		allowlist.length > 0
	) {
		return { mode: CODEX_CLAUDE_OAUTH_MODE_COMPAT, allowlist };
	}
	return { mode: CODEX_CLAUDE_OAUTH_MODE_SAFE, allowlist: [] };
}

function anthropicTextBlock(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

function textFromSystemBlocks(system: unknown): string {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) return "";
	const pieces: string[] = [];
	for (const block of system) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string" && text.length > 0) pieces.push(text);
	}
	return pieces.join("\n\n");
}

function computeClaudeCodeCompatFingerprint(systemText: string): string {
	const chars = [4, 7, 20].map((index) => systemText[index] ?? "0").join("");
	return crypto
		.createHash("sha256")
		.update(
			`${CLAUDE_CODE_COMPAT_FINGERPRINT_SALT}${chars}${CLAUDE_CODE_COMPAT_VERSION}`,
		)
		.digest("hex")
		.slice(0, 3);
}

function claudeCodeSessionId(seed: string | null): string {
	const h = crypto
		.createHash("sha256")
		.update(`claude-code-session:${seed || "better-ccflare-codex-responses"}`)
		.digest("hex");
	const variant = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(
		16,
	);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function applyClaudeCodeCompatShaping(
	body: ReturnType<typeof translateRequestToAnthropic>,
): void {
	const systemText = textFromSystemBlocks(body.system);
	const payload = JSON.stringify(body);
	const fingerprint = computeClaudeCodeCompatFingerprint(systemText);
	const cch = crypto
		.createHash("sha256")
		.update(payload)
		.digest("hex")
		.slice(0, 5);
	const billingHeader = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_COMPAT_VERSION}.${fingerprint}; cc_entrypoint=cli; cch=${cch};`;

	body.system = [
		anthropicTextBlock(billingHeader),
		anthropicTextBlock(
			"You are Claude Code, Anthropic's official CLI for Claude.",
		),
		anthropicTextBlock(CLAUDE_CODE_COMPAT_PROMPT),
	];

	if (!systemText.trim()) return;
	const firstUserIdx = body.messages.findIndex(
		(message) => message.role === "user",
	);
	if (firstUserIdx < 0) return;
	const firstUser = body.messages[firstUserIdx];
	if (!firstUser) return;
	body.messages = body.messages.slice();
	body.messages[firstUserIdx] = {
		...firstUser,
		content: [anthropicTextBlock(systemText.trim()), ...firstUser.content],
	};
}

function applyClaudeCodeCompatHeaders(
	headers: Headers,
	options: { stream?: boolean; sessionKey: string | null },
): void {
	headers.set(
		"accept",
		options.stream ? "text/event-stream" : "application/json",
	);
	headers.set("accept-language", "*");
	headers.set("anthropic-beta", CLAUDE_CODE_COMPAT_BETA);
	headers.set("anthropic-version", "2023-06-01");
	headers.set("user-agent", "@anthropic-ai/sdk/0.74.0");
	headers.set("x-app", "cli");
	headers.set("x-client-request-id", crypto.randomUUID());
	headers.set(
		"x-claude-code-session-id",
		claudeCodeSessionId(options.sessionKey),
	);
	headers.set("x-stainless-arch", process.arch);
	headers.set("x-stainless-lang", "js");
	headers.set("x-stainless-os", process.platform);
	headers.set("x-stainless-package-version", "0.74.0");
	headers.set("x-stainless-retry-count", "0");
	headers.set("x-stainless-runtime", "node");
	headers.set("x-stainless-runtime-version", process.version.slice(1));
	headers.set("x-stainless-timeout", "600");
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
	for (const header of INTERNAL_REQUEST_HEADERS) {
		syntheticHeaders.delete(header);
	}
	// Required by Anthropic API — Codex CLI doesn't send this header.
	if (!syntheticHeaders.has("anthropic-version")) {
		syntheticHeaders.set("anthropic-version", "2023-06-01");
	}
	syntheticHeaders.set(
		BETTER_CCFLARE_REQUEST_SOURCE_HEADER,
		CODEX_RESPONSES_REQUEST_SOURCE,
	);
	syntheticHeaders.delete(CODEX_CLAUDE_OAUTH_ALLOWLIST_HEADER);
	const codexClaudeOauthPolicy = resolveCodexClaudeOauthPolicy();
	syntheticHeaders.set(
		CODEX_CLAUDE_OAUTH_MODE_HEADER,
		codexClaudeOauthPolicy.mode,
	);
	if (codexClaudeOauthPolicy.mode === CODEX_CLAUDE_OAUTH_MODE_COMPAT) {
		// Explicit operator opt-in: better-ccflare owns Claude-Code-compatible
		// request shaping and account eligibility for this Codex Responses request.
		messagesUrl.searchParams.set("beta", "true");
		applyClaudeCodeCompatShaping(anthropicBody);
		removeCsvHeaderValue(
			syntheticHeaders,
			"x-better-ccflare-exclude-providers",
			"anthropic-oauth",
		);
		syntheticHeaders.set(
			CODEX_CLAUDE_OAUTH_ALLOWLIST_HEADER,
			codexClaudeOauthPolicy.allowlist.join(","),
		);
		applyClaudeCodeCompatHeaders(syntheticHeaders, {
			stream: anthropicBody.stream,
			sessionKey,
		});
	} else {
		// Claude OAuth accounts must stay excluded unless the operator explicitly
		// enables compat mode and supplies an allowlist.
		appendCsvHeader(
			syntheticHeaders,
			"x-better-ccflare-exclude-providers",
			"anthropic-oauth",
		);
	}
	const syntheticReq = new Request(messagesUrl.toString(), {
		method: "POST",
		headers: syntheticHeaders,
		body: JSON.stringify(anthropicBody),
	});

	// 6. Forward to proxy
	const routingLabel =
		codexClaudeOauthPolicy.mode === CODEX_CLAUDE_OAUTH_MODE_COMPAT
			? `source=${CODEX_RESPONSES_REQUEST_SOURCE} mode=${codexClaudeOauthPolicy.mode} allowlist_count=${codexClaudeOauthPolicy.allowlist.length}`
			: `source=${CODEX_RESPONSES_REQUEST_SOURCE} mode=${codexClaudeOauthPolicy.mode} exclude=anthropic-oauth`;
	log.info(
		`Forwarding responses request to ${messagesUrl.pathname}${messagesUrl.search} (${routingLabel})`,
	);
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
