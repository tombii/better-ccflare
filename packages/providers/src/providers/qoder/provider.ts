import { Logger } from "@better-ccflare/logger";
import {
	type AnthropicResponse,
	sanitizeHeaders,
	transformStreamingResponse,
} from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import {
	registerProviderModelDefaultFactory,
	resolveProviderModelDefault,
} from "../../provider-model-defaults";
import type {
	ProviderResponseContext,
	RateLimitInfo,
	TokenRefreshResult,
} from "../../types";
import {
	decodeQoderAccessToken,
	fetchQoderUserInfo,
	refreshQoderToken,
	resolveQoderOpenApiEndpoint,
} from "./auth-flow";
import {
	buildCosyHeaders,
	deriveQoderMachineId,
	encodeQoderBody,
} from "./cosy";
import { buildQoderRequest } from "./request-builder";
import {
	aggregateQoderSse,
	QoderAggregateError,
	qoderFrameToOpenAIChunk,
	type QoderStreamError,
	qoderStatusForCode,
	unwrapQoderSse,
} from "./sse-unwrap";

const log = new Logger("QoderProvider");

export const QODER_DEFAULT_GATEWAY_ENDPOINT = "https://api3.qoder.sh";

const QODER_CHAT_PATH =
	"/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const QODER_MODEL_LIST_PATH = "/algo/api/v2/model/list";

/**
 * Count_tokens is answered locally: Qoder has no count endpoint, and
 * Anthropic's is advisory, so the client's own message body is all the answer
 * needs. The proxy may or may not keep the path when it rewrites the URL, so
 * both the path and the body shape are recognised.
 */
const QODER_COUNT_TOKENS_PATH = "/v1/messages/count_tokens";

// The proxy only materialises a synthetic response from a URL under
// `https://better-ccflare.local/` (SYNTHETIC_RESPONSE_URL_PREFIX); the path
// segment after the origin is ours to choose.
const QODER_SYNTHETIC_COUNT_TOKENS_URL =
	"https://better-ccflare.local/qoder/count_tokens";

/** Both free models are reasoning models; the paid catalogue is not assumed. */
const QODER_REASONING_MODELS = new Set(["qfmodel", "dfmodel"]);

const QODER_MODEL_DEFAULTS = {
	fable: "qfmodel",
	opus: "qfmodel",
	sonnet: "dfmodel",
	haiku: "dfmodel",
};

registerProviderModelDefaultFactory("qoder", QODER_MODEL_DEFAULTS);

/**
 * Stream intent travels client -> upstream as `x-better-ccflare-request-stream`
 * (the proxy copies request signalling headers onto the response for
 * providers), and the chosen model key travels upstream -> response as
 * `x-better-ccflare-qoder-model`, so `processResponse` knows what was asked
 * for without trusting the `"auto"` Qoder echoes back.
 */
const STREAM_INTENT_HEADER = "x-better-ccflare-request-stream";
const QODER_MODEL_HEADER = "x-better-ccflare-qoder-model";
const REQUEST_PATH_HEADER = "x-better-ccflare-request-path";

/**
 * Per-account identity the COSY envelope needs and the account row does not
 * hold: the uid (from /api/v1/userinfo) and a machine id derived from it.
 * Cached because every request signs with them; the uid is invariant for an
 * account, and a token change re-fetches it.
 */
interface QoderIdentity {
	uid: string;
	machineId: string;
	tokenKey: string;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Qoder gateway provider.
 *
 * The upstream is Qoder's own protocol, not OpenAI: the request body is a
 * Qoder envelope (encoded + COSY-signed), and the response is SSE frames whose
 * `body` is a JSON string. `transformRequestBody` builds the former,
 * `processResponse` unwraps the latter into plain OpenAI SSE and hands it to
 * the shared Anthropic emitter. See QODER_INTEGRATION.md §6.3.
 */
export class QoderProvider extends BaseProvider {
	name = "qoder";

	private readonly identities = new Map<string, QoderIdentity>();
	/** The model key each prepared request asked for (response attribution). */
	private readonly prepared = new WeakMap<Request, string>();

	canHandle(path: string): boolean {
		return (
			path === "/v1/messages" ||
			path === "/v1/messages/count_tokens" ||
			path === "/v1/models"
		);
	}

	async refreshToken(account: Account): Promise<TokenRefreshResult> {
		return refreshQoderToken(account);
	}

	/** A PAT needs no browser flow, but it is a renewable credential. */
	supportsOAuth(): boolean {
		return true;
	}

	supportsUsageTracking(): boolean {
		return true;
	}

	/** The model key this request asked for, for diagnostics and tests. */
	modelKeyFor(request: Request): string | undefined {
		return this.prepared.get(request);
	}

	buildUrl(path: string, _query: string, account?: Account): string {
		const gateway = this.resolveGatewayEndpoint(account);
		if (path === "/v1/messages" || path === "/v1/messages/count_tokens") {
			return `${gateway}${QODER_CHAT_PATH}`;
		}
		if (path === "/v1/models") {
			return `${gateway}${QODER_MODEL_LIST_PATH}`;
		}
		return `${gateway}${path}`;
	}

	/**
	 * The gateway host. An account's `custom_endpoint` selects the CN region
	 * (`https://gateway.qoder.com.cn`) and may be JSON with an `endpoint`
	 * member, the same shape other providers accept.
	 */
	private resolveGatewayEndpoint(account?: Account): string {
		const raw = account?.custom_endpoint?.trim() ?? "";
		let candidate = raw;
		if (raw.startsWith("{")) {
			try {
				const parsed = JSON.parse(raw) as { endpoint?: unknown };
				candidate = typeof parsed.endpoint === "string" ? parsed.endpoint : "";
			} catch {
				candidate = "";
			}
		}
		while (candidate.endsWith("/")) candidate = candidate.slice(0, -1);
		return candidate || QODER_DEFAULT_GATEWAY_ENDPOINT;
	}

	/**
	 * Strip every header that belongs to the client's call to this proxy, and
	 * every credential header. What is left is passed through (content-type and
	 * the proxy's own signalling headers).
	 */
	private clientHeaders(headers: Headers): Headers {
		const out = new Headers(headers);
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
			"x-request-id",
		]) {
			out.delete(name);
		}
		for (const key of [...out.keys()]) {
			if (
				key.startsWith("x-better-ccflare-") ||
				key.startsWith("cf-") ||
				key.startsWith("x-forwarded-")
			) {
				out.delete(key);
			}
		}
		return out;
	}

	/**
	 * The COSY signature covers the encoded body, which this hook never sees
	 * (it runs before the body is transformed). It therefore contributes only
	 * the signing-relevant identity headers; `transformRequestBody` re-signs
	 * the request with the complete envelope.
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const out = this.clientHeaders(headers);
		if (accessToken === undefined && apiKey === undefined) return out;

		const decoded = decodeQoderAccessToken(accessToken);
		if (!decoded?.token) return out;
		const identity = this.peekIdentity(decoded.token);
		if (identity) {
			out.set("Cosy-User", identity.uid);
			out.set("Cosy-Machineid", identity.machineId);
			out.set("Cosy-Machinetoken", identity.machineId);
		}
		return out;
	}

	private peekIdentity(token: string): QoderIdentity | undefined {
		for (const identity of this.identities.values()) {
			if (identity.tokenKey === token) return identity;
		}
		return undefined;
	}

	private async ensureIdentity(
		account: Account,
		token: string,
	): Promise<QoderIdentity> {
		const cached = this.identities.get(account.id);
		if (cached && cached.tokenKey === token) return cached;

		const info = await fetchQoderUserInfo(token, account.custom_endpoint);
		if (!info) {
			throw new Error(
				`Qoder userinfo failed for account ${account.name}: cannot sign the request (the job token may be dead)`,
			);
		}
		const identity: QoderIdentity = {
			uid: info.uid,
			machineId: deriveQoderMachineId(info.uid),
			tokenKey: token,
		};
		this.identities.set(account.id, identity);
		log.debug(`Cached Qoder identity for account ${account.name}`);
		return identity;
	}

	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		if (!account) return request;
		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) return request;

		// Read the body exactly once: it may have been consumed already (the
		// proxy's replays), and every decision below works from this one parse.
		const text = await request.text();
		const body = tryParseJsonObject(text);

		if (
			request.url.includes(QODER_COUNT_TOKENS_PATH) ||
			(body && isCountTokensRequest(request, body))
		) {
			// Answer at the synthetic origin: that prefix is what tells the proxy
			// not to send this request upstream.
			return this.createSyntheticJsonResponse(
				new Request(QODER_SYNTHETIC_COUNT_TOKENS_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
				}),
				200,
				{ input_tokens: 0 },
			);
		}

		// A request the proxy already transformed and is now replaying
		// (in-place retries on 529/5xx, model fallback, recovery paths). Its
		// body is the encoded wire form and the signature is valid for one
		// send only, so re-sign it rather than encoding it a second time.
		const replayedModel = request.headers.get(QODER_MODEL_HEADER);
		let encoded: string;
		let modelKey: string;
		if (body) {
			modelKey = typeof body.model === "string" ? body.model : "";
			// Throws for a Claude model id: that is a client configuration error,
			// not something Qoder could fall back from.
			const qoderBody = buildQoderRequest(body, { sessionScope: account.id });
			encoded = encodeQoderBody(JSON.stringify(qoderBody));
		} else if (replayedModel !== null) {
			encoded = text;
			modelKey = replayedModel;
		} else {
			// Neither a client body nor this provider's own wire form.
			return request;
		}

		const decoded = decodeQoderAccessToken(account.access_token);
		if (!decoded?.token) {
			throw new Error(
				`Qoder account ${account.name} has no job token; refresh it before sending`,
			);
		}
		const identity = await this.ensureIdentity(account, decoded.token);

		const { headers: cosy } = buildCosyHeaders({
			url: request.url,
			body: encoded,
			creds: { uid: identity.uid, token: decoded.token },
			machineId: identity.machineId,
		});

		const headers = this.clientHeaders(request.headers);
		headers.set("content-type", "application/json");
		headers.delete("content-length");
		headers.set(
			STREAM_INTENT_HEADER,
			body
				? body.stream === true
					? "true"
					: "false"
				: streamIntentOf(request),
		);
		headers.set(QODER_MODEL_HEADER, modelKey);
		if (modelKey) {
			headers.set("X-Model-Key", modelKey);
			headers.set("X-Model-Source", "system");
		}
		for (const [name, value] of Object.entries(cosy)) {
			headers.set(name, value);
		}

		const signed = new Request(request.url, {
			method: request.method,
			headers,
			body: encoded,
			signal: request.signal,
		});
		this.prepared.set(signed, modelKey);
		return signed;
	}

	async processResponse(
		response: Response,
		account: Account | null,
		requestHeaders?: Headers,
		_drainAbort?: AbortController,
		context?: ProviderResponseContext,
	): Promise<Response> {
		if (response.headers.get(REQUEST_PATH_HEADER) === "/v1/models") {
			return this.transformModelList(response);
		}

		const contentType = response.headers.get("content-type")?.toLowerCase();
		if (!contentType?.includes("text/event-stream")) {
			return this.translatePassthrough(response, account);
		}

		const model =
			response.headers.get(QODER_MODEL_HEADER) ||
			context?.requestModel ||
			"unknown";
		const clientWantsJson =
			response.headers.get(STREAM_INTENT_HEADER) === "false" ||
			requestHeaders?.get(STREAM_INTENT_HEADER) === "false";

		if (clientWantsJson) {
			return this.aggregateResponse(response, model, account);
		}

		// The shared emitter has no error path, so the stream's outcome is
		// determined first: an in-band failure becomes a real error response
		// with a mapped status, never a truncated 200.
		const peek = await peekQoderStream(response.body);
		if (peek.error) {
			log.warn(`Qoder stream failed for ${account?.name ?? "account"}`, {
				status: peek.error.status,
				code: peek.error.code ?? null,
				message: peek.error.message.slice(0, 300),
			});
			return qoderErrorResponse(peek.error);
		}
		const body = new Response(peek.body, {
			status: response.status,
			headers: response.headers,
		});
		return transformStreamingResponse(
			unwrapQoderSse(body, {
				model,
				onError: (error) =>
					log.warn(
						`Qoder stream failed mid-response for ${account?.name ?? "account"}`,
						{
							status: error.status,
							code: error.code ?? null,
							message: error.message.slice(0, 300),
						},
					),
			}),
			{ fallbackModel: model },
		);
	}

	/**
	 * Qoder answers a busy model with HTTP 403 and a nested `10605`
	 * (`RESOURCE_LIMIT`, "queued") — a transient saturation notice, not a
	 * credential or request problem. Relabel it 503 + `Retry-After` so the
	 * proxy's retry/failover logic treats it the way Qoder's own error table
	 * says it should. Every other non-2xx passes through unchanged.
	 */
	private async translatePassthrough(
		response: Response,
		account: Account | null,
	): Promise<Response> {
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("json")) {
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: sanitizeHeaders(response.headers),
			});
		}
		// Buffered: a busy answer is relabelled rather than passed through.
		const text = await response.text();
		if (response.status < 400) {
			return new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: sanitizeHeaders(response.headers),
			});
		}
		const busy = parseBusyError(text);
		if (busy) {
			log.info(`Qoder busy for ${account?.name ?? "account"}`, {
				retry_after_seconds: busy.retryAfterSeconds,
				upstream_status: response.status,
			});
			const headers = new Headers({
				"content-type": "application/json",
				"retry-after": String(busy.retryAfterSeconds),
			});
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "overloaded_error",
						message: `Qoder is busy (queued); retry after ${busy.retryAfterSeconds}s`,
					},
				}),
				{ status: 503, headers },
			);
		}
		return new Response(text, {
			status: response.status,
			statusText: response.statusText,
			headers: sanitizeHeaders(response.headers),
		});
	}

	/**
	 * Qoder is always asked to stream. A client that asked for JSON gets the
	 * stream aggregated into one Anthropic message; an in-band failure becomes
	 * an error response with the HTTP status Qoder's code maps to.
	 */
	private async aggregateResponse(
		response: Response,
		model: string,
		account: Account | null,
	): Promise<Response> {
		try {
			const message = await aggregateQoderSse(response, model);
			return new Response(JSON.stringify(message), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			if (error instanceof QoderAggregateError) {
				log.warn(`Qoder stream failed for ${account?.name ?? "account"}`, {
					status: error.status,
					code: error.code ?? null,
					message: error.message.slice(0, 300),
				});
				return qoderErrorResponse({
					status: error.status,
					message: error.message,
					...(error.code !== undefined ? { code: error.code } : {}),
					...(error.retryAfterSeconds !== undefined
						? { retryAfterSeconds: error.retryAfterSeconds }
						: {}),
				});
			}
			// Not an upstream answer: a truncated or unparseable stream.
			const message = error instanceof Error ? error.message : String(error);
			log.warn(`Qoder stream ended abnormally for ${account?.name ?? "account"}`, {
				message: message.slice(0, 300),
			});
			return qoderErrorResponse({ status: 502, message });
		}
	}

	parseRateLimit(response: Response): RateLimitInfo {
		if (response.status !== 429) return { isRateLimited: false };
		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;
		if (retryAfter) {
			const seconds = Number(retryAfter);
			resetTime = Number.isNaN(seconds)
				? new Date(retryAfter).getTime()
				: Date.now() + seconds * 1000;
		}
		return { isRateLimited: true, resetTime };
	}

	/** Qoder openapi base for this account (usage fetcher / diagnostics). */
	openApiEndpoint(account?: Account | null): string {
		return resolveQoderOpenApiEndpoint(account?.custom_endpoint);
	}

	private async transformModelList(response: Response): Promise<Response> {
		if (!response.ok) return response;
		try {
			const raw = (await response.json()) as Record<string, unknown>;
			const scene = Array.isArray(raw.chat) ? raw.chat : [];
			const createdAt = new Date().toISOString();
			const data: Array<{
				type: "model";
				id: string;
				display_name: string;
				created_at: string;
			}> = [];
			for (const entry of scene) {
				if (!entry || typeof entry !== "object") continue;
				const model = entry as Record<string, unknown>;
				if (typeof model.key !== "string" || !model.key) continue;
				// `enable: false` means this account may not call the model.
				if (model.enable === false) continue;
				data.push({
					type: "model",
					id: model.key,
					display_name:
						typeof model.display_name === "string"
							? model.display_name
							: model.key,
					created_at: createdAt,
				});
			}
			return new Response(
				JSON.stringify({
					data,
					has_more: false,
					first_id: data[0]?.id ?? null,
					last_id: data[data.length - 1]?.id ?? null,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		} catch (error) {
			log.warn(`Failed to transform Qoder model list: ${String(error)}`);
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "api_error",
						message: "Qoder model list could not be parsed",
					},
				}),
				{ status: 502, headers: { "Content-Type": "application/json" } },
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
}

/**
 * Detect Qoder's queued/busy answer in any of the shapes it sends: a flat
 * `{code: 10605}`, or the gateway's `{code:"403", message:"{\"code\":\"10605\",…}"}`
 * nest. Returns the wait it suggests, defaulting to 30s.
 */
export function parseBusyError(
	text: string,
): { retryAfterSeconds: number } | null {
	const decoded = qoderFrameToOpenAIChunk(
		text.trim().startsWith("data:") ? text : `data:${text}`,
	);
	if ("empty" in decoded || decoded.ok) return null;
	if (decoded.error.code !== 10605) return null;
	return { retryAfterSeconds: decoded.error.retryAfterSeconds ?? 30 };
}

/**
 * Read a Qoder SSE body far enough to learn its outcome: the first content
 * frame, an in-band error, or `[DONE]` for an empty answer. The body is
 * buffered (answers are a few dozen KB of JSON) and returned as a fresh stream
 * for the unwrap: relaying a partially read upstream stream is not reliable
 * across runtimes, and a second reader on the same Response tees a branch
 * nothing consumes (#382).
 */
async function peekQoderStream(
	body: ReadableStream<Uint8Array> | null,
): Promise<
	| { error: QoderStreamError; text: ""; body: null }
	| { error: null; text: string; body: ReadableStream<Uint8Array> }
> {
	if (!body) {
		return {
			error: { status: 502, message: "Qoder returned an empty response" },
			text: "",
			body: null,
		};
	}

	const text = await new Response(body).text();
	let sawOutcome = false;
	for (const line of text.split("\n")) {
		const frame = qoderFrameToOpenAIChunk(line);
		if ("empty" in frame) {
			if (frame.done) sawOutcome = true;
			continue;
		}
		if (!frame.ok) {
			return { error: frame.error, text: "", body: null };
		}
		if (frame.chunk.choices?.length) {
			sawOutcome = true;
			break;
		}
	}
	if (!sawOutcome) {
		return {
			error: { status: 502, message: "Qoder returned an empty stream" },
			text: "",
			body: null,
		};
	}

	const bytes = new TextEncoder().encode(text);
	return {
		error: null,
		text,
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	};
}

function qoderErrorResponse(error: QoderStreamError): Response {
	const headers = new Headers({ "content-type": "application/json" });
	if (error.retryAfterSeconds !== undefined) {
		headers.set("retry-after", String(error.retryAfterSeconds));
	}
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: errorTypeForStatus(error.status), message: error.message },
		}),
		{ status: error.status, headers },
	);
}

function errorTypeForStatus(status: number): string {
	switch (status) {
		case 401:
			return "authentication_error";
		case 429:
			return "rate_limit_error";
		case 503:
			return "overloaded_error";
		case 400:
			return "invalid_request_error";
		default:
			return "api_error";
	}
}

/**
 * Whether this is a count_tokens request. The proxy rewrites the URL to
 * buildUrl() first, so /v1/messages and /v1/messages/count_tokens arrive at
 * the same chat route; a messages body always carries `max_tokens` and
 * `stream`, a count_tokens body typically neither.
 */
function isCountTokensRequest(
	request: Request,
	body: Record<string, unknown>,
): boolean {
	if (request.url === QODER_SYNTHETIC_COUNT_TOKENS_URL) return true;
	if (!request.url.includes(QODER_CHAT_PATH.split("?")[0])) return false;
	return !("max_tokens" in body) && !("stream" in body);
}

/**
 * Stream intent for a replayed (already encoded) request: the header set when
 * it was first transformed, defaulting to stream — Qoder is always asked to
 * stream, and the aggregation path copes either way.
 */
function streamIntentOf(request: Request): string {
	const flagged = request.headers.get(STREAM_INTENT_HEADER);
	return flagged === "false" ? "false" : "true";
}

export const QODER_KNOWN_MODELS = {
	reasoning: [...QODER_REASONING_MODELS],
	modelDefaults: QODER_MODEL_DEFAULTS,
	statusForCode: qoderStatusForCode,
	resolveProviderModelDefault,
};

export type { AnthropicResponse };
