import { getModelFamily, mapModelName } from "@better-ccflare/core";
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
} from "./auth-flow";
import {
	buildCosyHeaders,
	decodeQoderBody,
	deriveQoderMachineId,
	encodeQoderBody,
} from "./cosy";
import {
	QODER_DEFAULT_GATEWAY_ENDPOINT,
	resolveQoderGatewayEndpoint,
	resolveQoderOpenApiEndpoint,
} from "./endpoints";
import { buildQoderRequest, isClaudeModelId } from "./request-builder";
import {
	aggregateQoderSse,
	detectQoderBusy,
	isQoderDuplicateRequest,
	QODER_DUPLICATE_REQUEST_CODE,
	QoderAggregateError,
	type QoderStreamError,
	qoderFrameToOpenAIChunk,
	qoderStatusForCode,
	unwrapQoderSse,
} from "./sse-unwrap";

const log = new Logger("QoderProvider");

// Re-exported: the default lives with the endpoint resolvers now, but the
// provider barrel has always exported it from here.
export { QODER_DEFAULT_GATEWAY_ENDPOINT };

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
/**
 * The request's own uuid, carried across a replay so the re-signed envelope
 * keeps the id the body was built with.
 */
const QODER_REQUEST_ID_HEADER = "x-better-ccflare-qoder-request-id";
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
	/**
	 * The last wire key this provider sent for an account.
	 *
	 * The upstream response is tagged with the model key, but the proxy only
	 * copies a fixed list of internal headers back — and the transformed body is
	 * an encoded wire string, so the proxy's own `requestModel` is empty for
	 * Qoder. This is what the response falls back to when the tag is missing.
	 */
	private readonly lastModelByAccount = new Map<string, string>();

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
	 * The gateway host: the one that serves chat and the model list. An
	 * account's `custom_endpoint` names it (the CN region uses
	 * `https://gateway.qoder.com.cn`); the OpenAPI host is derived from it.
	 */
	private resolveGatewayEndpoint(account?: Account): string {
		return resolveQoderGatewayEndpoint(account);
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

		const info = await fetchQoderUserInfo(token, account);
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
			// not to send this request upstream. The estimate is local: Qoder has no
			// count endpoint, and Anthropic's is advisory anyway.
			return this.createSyntheticJsonResponse(
				new Request(QODER_SYNTHETIC_COUNT_TOKENS_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
				}),
				200,
				{ input_tokens: estimateQoderCountTokens(body) },
			);
		}

		// A request the proxy already transformed and is now replaying
		// (in-place retries on 529/5xx, model fallback, recovery paths). Its
		// body is the encoded wire form and the signature is valid for one
		// send only, so re-sign it rather than encoding it a second time.
		const replayedModel = request.headers.get(QODER_MODEL_HEADER);
		let encoded: string;
		let modelKey: string;
		let requestId: string;
		if (body) {
			// ONE uuid identifies this request in the body, in the COSY envelope
			// and in the X-Request-Id header.
			requestId = crypto.randomUUID();
			// The client sends a Claude model id; Qoder only knows wire keys. The
			// resolution is the account's business (its model mappings, then the
			// provider's family defaults), so it happens here, where the account is.
			modelKey = resolveQoderModelKey(
				typeof body.model === "string" ? body.model : "",
				account,
			);
			const qoderBody = buildQoderRequest(body, {
				sessionScope: account.id,
				modelKey,
				requestId,
			});
			encoded = encodeQoderBody(JSON.stringify(qoderBody));
		} else if (replayedModel !== null) {
			modelKey = replayedModel;
			// A replay is a RESEND, and Qoder refuses a byte-identical resend as a
			// duplicate (code 103). The resend therefore gets a fresh per-request
			// id and a fresh signature; the conversation identity is untouched.
			const refreshed = await this.resignWithFreshId(request, account, text);
			if (refreshed) {
				this.lastModelByAccount.set(account.id, modelKey);
				return refreshed;
			}
			// The body could not be re-signed (not a Qoder wire body, or the
			// account cannot be signed for): fall back to re-signing what we have,
			// which is what this path always did.
			requestId =
				request.headers.get(QODER_REQUEST_ID_HEADER) ?? crypto.randomUUID();
			encoded = text;
		} else {
			// Neither a client body nor this provider's own wire form.
			return request;
		}
		this.lastModelByAccount.set(account.id, modelKey);

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
			requestId,
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
		headers.set(QODER_REQUEST_ID_HEADER, requestId);
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

	/**
	 * Give a resend of this request a fresh identity.
	 *
	 * Qoder refuses a byte-identical resend of a request it has already seen
	 * (code 103, "Duplicate request"), and the proxy's in-place 529/5xx
	 * retries replay the request verbatim — same body bytes, same signature,
	 * same id — so every retry of a Qoder request was refused as a duplicate.
	 *
	 * The body is decoded, given a fresh `request_id` and a fresh
	 * `business.id`, re-encoded and re-signed. The conversation identity
	 * (`request_set_id`, `chat_record_id`, `session_id`) is left alone: that is
	 * what makes the resend a resend of the SAME conversation.
	 *
	 * A body that is not a Qoder wire body, or an account that cannot be
	 * signed for, is returned exactly as it came in — a resend that cannot be
	 * re-signed is still better than no resend.
	 */
	async refreshRequestIdentity(
		request: Request,
		account: Account | null,
	): Promise<Request> {
		if (!account) return request;
		let encoded: string;
		try {
			// The clone leaves the caller's request readable, so a body that
			// cannot be refreshed is returned unchanged — body included.
			encoded = await request.clone().text();
		} catch {
			return request;
		}
		const refreshed = await this.resignWithFreshId(request, account, encoded);
		return refreshed ?? request;
	}

	/**
	 * Re-sign an encoded Qoder wire body with a fresh per-request id.
	 *
	 * @returns the re-signed request, or null when the body is not a Qoder wire
	 *   body or the account cannot be signed for
	 */
	private async resignWithFreshId(
		request: Request,
		account: Account,
		encoded: string,
	): Promise<Request | null> {
		const decoded = decodeQoderBody(encoded);
		if (!decoded) return null;
		const body = tryParseJsonObject(decoded);
		if (!body) return null;
		// Not the Qoder request JSON: leave it alone.
		if (typeof body.request_id !== "string") return null;

		// ONE uuid identifies the request in the body, in the COSY envelope and
		// in the X-Request-Id header — the invariant the first transform keeps.
		const requestId = crypto.randomUUID();
		body.request_id = requestId;
		const business = body.business;
		if (business && typeof business === "object" && !Array.isArray(business)) {
			(business as Record<string, unknown>).id = crypto.randomUUID();
		}
		const refreshedBody = encodeQoderBody(JSON.stringify(body));

		const decodedToken = decodeQoderAccessToken(account.access_token);
		if (!decodedToken?.token) return null;
		let identity: QoderIdentity;
		try {
			identity = await this.ensureIdentity(account, decodedToken.token);
		} catch (error) {
			log.warn(
				`Qoder cannot re-sign a resent request for ${account.name}: ${String(error)}`,
			);
			return null;
		}

		const { headers: cosy } = buildCosyHeaders({
			url: request.url,
			body: refreshedBody,
			creds: { uid: identity.uid, token: decodedToken.token },
			machineId: identity.machineId,
			requestId,
		});

		// Everything the request already carried (content-type, the model key,
		// the stream intent) stays; only the COSY envelope and the request id
		// are replaced.
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		headers.set("content-type", "application/json");
		headers.set(QODER_REQUEST_ID_HEADER, requestId);
		for (const [name, value] of Object.entries(cosy)) {
			headers.set(name, value);
		}

		const refreshed = new Request(request.url, {
			method: request.method,
			headers,
			body: refreshedBody,
			signal: request.signal,
		});
		const modelKey = request.headers.get(QODER_MODEL_HEADER);
		if (modelKey) {
			this.prepared.set(refreshed, modelKey);
			this.lastModelByAccount.set(account.id, modelKey);
		}
		return refreshed;
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

		// The proxy tags the response with the model key it saw on the request.
		// When that tag is missing, the proxy's own model is empty for Qoder
		// (the transformed body is an encoded wire string, not JSON), so the
		// fallback is the last key this provider sent for the account.
		const model =
			response.headers.get(QODER_MODEL_HEADER) ||
			context?.requestModel ||
			(account ? this.lastModelByAccount.get(account.id) : undefined) ||
			"unknown";
		const clientWantsJson =
			response.headers.get(STREAM_INTENT_HEADER) === "false" ||
			requestHeaders?.get(STREAM_INTENT_HEADER) === "false";

		// The shared emitter has no error path, so the stream's outcome is
		// determined first: an in-band failure becomes a real error response
		// with a mapped status, never a truncated 200. The peek is incremental
		// because the gateway holds the connection open after an error frame.
		const peek = await peekQoderStream(response.body);
		if (peek.error) {
			log.warn(`Qoder stream failed for ${account?.name ?? "account"}`, {
				status: peek.error.status,
				code: peek.error.code ?? null,
				message: peek.error.message.slice(0, 300),
			});
			return qoderErrorResponse(peek.error);
		}
		const reader = peek.reader;
		const body = new Response(relayQoderStream(peek.head, reader), {
			status: response.status,
			headers: response.headers,
		});

		if (clientWantsJson) {
			return this.aggregateResponse(body, model, account, reader);
		}

		return transformStreamingResponse(
			unwrapQoderSse(body, {
				model,
				onError: (error) => {
					log.warn(
						`Qoder stream failed mid-response for ${account?.name ?? "account"}`,
						{
							status: error.status,
							code: error.code ?? null,
							message: error.message.slice(0, 300),
						},
					);
					// The gateway holds the connection open after an error frame, so
					// the upstream reader is cancelled here: without it the socket
					// stays open for as long as the gateway keeps it.
					void reader.cancel(error.message).catch(() => {});
				},
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
		if (isQoderDuplicateRequest(text)) {
			// Qoder refused a RESEND as a duplicate. That is not a server error:
			// the account is fine and the upstream is fine, the resend itself was
			// refused. Forwarded as 409 so the proxy does not bench the account
			// for a minute over a retry it should not have made.
			log.warn(
				`Qoder refused a duplicate request for ${account?.name ?? "account"}`,
			);
			return qoderErrorResponse({
				status: 409,
				code: QODER_DUPLICATE_REQUEST_CODE,
				message:
					"Qoder refused the request as a duplicate: it was already sent",
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
		reader?: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<Response> {
		try {
			const message = await aggregateQoderSse(response, model);
			return new Response(JSON.stringify(message), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			// The gateway holds the connection open after an error frame, so the
			// upstream reader is released here as well.
			if (reader) void reader.cancel(String(error)).catch(() => {});
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
			log.warn(
				`Qoder stream ended abnormally for ${account?.name ?? "account"}`,
				{
					message: message.slice(0, 300),
				},
			);
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
		return resolveQoderOpenApiEndpoint(account);
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
 * Detect Qoder's queued/busy answer in any of the shapes it sends.
 *
 * Two shapes, both real:
 *
 *   1. the SSE envelope — `data:{"headers":…,"body":"…","statusCodeValue":403}`;
 *   2. a BARE JSON body — `{"code":"403","message":"{\"code\":\"10605\",…}"}`.
 *
 * The second shape is not an envelope: read as one it has no status code and
 * no body, so it used to be passed through as the 403 it arrived as, instead
 * of being relabelled 503 + Retry-After. Its layers are merged the same way
 * the envelope's are, so the queue hint is found wherever it sits.
 *
 * Returns the wait it suggests, defaulting to 30s.
 */
export function parseBusyError(
	text: string,
): { retryAfterSeconds: number } | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	// Shape 1: the SSE envelope (or a bare JSON envelope, read as one).
	const decoded = qoderFrameToOpenAIChunk(
		trimmed.startsWith("data:") ? trimmed : `data:${trimmed}`,
	);
	if (!("empty" in decoded) && !decoded.ok) {
		if (decoded.error.code !== 10605) return null;
		return { retryAfterSeconds: decoded.error.retryAfterSeconds ?? 30 };
	}

	// Shape 2: a bare JSON body.
	const parsed = tryParseJsonObject(trimmed);
	if (!parsed) return null;
	return detectQoderBusy(parsed);
}

/**
 * Resolve the client's model to a Qoder wire key.
 *
 * Claude Code always asks for a Claude model id, and Qoder only knows wire
 * keys (`qfmodel`, `dfmodel`, …), so the mapping has to happen here — where
 * the account is. Precedence:
 *
 *   1. a model that is already a wire key is used verbatim;
 *   2. the account's own model mappings (what the CLI asks for);
 *   3. the provider's family defaults (the operator's override, the account's
 *      derived defaults, then the built-in map).
 *
 * @throws when nothing resolves to a wire key
 */
export function resolveQoderModelKey(
	requested: string,
	account: Account,
): string {
	const model = requested.trim();
	if (!model) {
		throw new Error("Qoder requires a model in the request body");
	}
	if (!isClaudeModelId(model)) return model;

	const mapped = mapModelName(model, account);
	if (mapped && !isClaudeModelId(mapped)) return mapped;

	const family = getModelFamily(model);
	if (family) {
		const resolved = resolveProviderModelDefault("qoder", family, account.id);
		if (resolved && !isClaudeModelId(resolved)) return resolved;
	}

	throw new Error(
		`Qoder cannot serve the model "${model}": no Qoder wire key is mapped for it (set a model mapping for the account, or a provider model default for "${family ?? "unknown"}")`,
	);
}

/**
 * A conservative estimate of the prompt's token count.
 *
 * Qoder has no count endpoint. Anthropic's is advisory for client-side
 * budgeting, so a local estimate over the prompt material is better than an
 * answer of zero — the same approach CodeBuddy takes.
 */
export function estimateQoderCountTokens(body: unknown): number {
	const material = extractCountTokensMaterial(body);
	let serialized = material.join("\n");
	if (serialized.length === 0) {
		try {
			serialized = JSON.stringify(body) ?? "";
		} catch {
			serialized = String(body ?? "");
		}
	}
	return Math.max(1, Math.ceil(serialized.length / 3));
}

function extractCountTokensMaterial(body: unknown): string[] {
	if (!body || typeof body !== "object") return [];
	const request = body as Record<string, unknown>;
	const chunks: string[] = [];
	appendCountTokensContent(chunks, request.system);
	const messages = request.messages;
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			const msg = message as Record<string, unknown>;
			if (typeof msg.role === "string") chunks.push(msg.role);
			appendCountTokensContent(chunks, msg.content);
		}
	}
	const tools = request.tools;
	if (Array.isArray(tools)) {
		for (const tool of tools) {
			appendCountTokensContent(chunks, tool);
		}
	}
	return chunks;
}

function appendCountTokensContent(chunks: string[], value: unknown): void {
	if (typeof value === "string") {
		chunks.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			appendCountTokensContent(chunks, item);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	const before = chunks.length;
	if (typeof record.text === "string") chunks.push(record.text);
	if (typeof record.name === "string") chunks.push(record.name);
	if (typeof record.description === "string") chunks.push(record.description);
	if ("input" in record) appendCountTokensContent(chunks, record.input);
	if ("content" in record) appendCountTokensContent(chunks, record.content);
	if ("input_schema" in record) {
		appendCountTokensContent(chunks, record.input_schema);
	}
	if ("parameters" in record) {
		appendCountTokensContent(chunks, record.parameters);
	}
	if (Object.keys(record).length > 0 && chunks.length === before) {
		try {
			chunks.push(JSON.stringify(record));
		} catch {
			// Ignore non-serializable objects; the caller has a fallback.
		}
	}
}

/**
 * How long to wait for the gateway's first frame before giving up.
 *
 * The busy answer arrives in well under a second, and a healthy stream starts
 * just as fast; anything slower is a stalled connection, not a slow model.
 */
export const QODER_FIRST_FRAME_TIMEOUT_MS = 30_000;

type QoderPeek =
	| {
			/** The stream opens with an in-band failure: nothing to relay. */
			error: QoderStreamError;
			head: Uint8Array;
			reader: null;
	  }
	| {
			error: null;
			/** The bytes the peek consumed; the consumer must see them too. */
			head: Uint8Array;
			/** The reader, positioned after `head`, for the rest of the stream. */
			reader: ReadableStreamDefaultReader<Uint8Array>;
	  };

/**
 * Read a Qoder SSE body only far enough to learn its outcome: the first
 * content frame, or an in-band error.
 *
 * The read is INCREMENTAL and bounded on purpose. Qoder's gateway answers a
 * saturated model with an error frame and then **holds the SSE connection
 * open indefinitely** — a whole-body read would wait for a close that never
 * comes and wedge the request. So the peek stops at the first frame that
 * decides the outcome, and the bytes it consumed are handed back for replay.
 */
export async function peekQoderStream(
	body: ReadableStream<Uint8Array> | null,
	timeoutMs: number = QODER_FIRST_FRAME_TIMEOUT_MS,
): Promise<QoderPeek> {
	if (!body) {
		return {
			error: { status: 502, message: "Qoder returned an empty response" },
			head: new Uint8Array(0),
			reader: null,
		};
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	const consumed: Uint8Array[] = [];
	let text = "";
	// A TOTAL deadline for the peek, not a per-read one: a stream that keeps
	// sending keep-alive comments would otherwise keep the peek alive forever.
	const deadline = Date.now() + timeoutMs;

	const head = (): Uint8Array => {
		const total = consumed.reduce((sum, chunk) => sum + chunk.length, 0);
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of consumed) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	};

	for (;;) {
		let next:
			| { done: true }
			| { done: false; value: Uint8Array }
			| typeof TIMEOUT;
		const remaining = deadline - Date.now();
		try {
			next = await withTimeout(reader.read(), remaining > 0 ? remaining : 1);
		} catch (_error) {
			void reader.cancel().catch(() => {});
			return {
				error: {
					status: 504,
					message: `Qoder sent no response within ${timeoutMs}ms`,
				},
				head: new Uint8Array(0),
				reader: null,
			};
		}
		if (next === TIMEOUT) {
			void reader.cancel().catch(() => {});
			return {
				error: {
					status: 504,
					message: `Qoder sent no response within ${timeoutMs}ms`,
				},
				head: new Uint8Array(0),
				reader: null,
			};
		}
		if (next.done) {
			void reader.cancel().catch(() => {});
			// A final frame without a trailing newline is still a frame.
			const outcome = text.trim() ? considerQoderFrame(text) : null;
			if (outcome?.error) {
				return {
					error: outcome.error,
					head: new Uint8Array(0),
					reader: null,
				};
			}
			return {
				error: { status: 502, message: "Qoder returned an empty stream" },
				head: new Uint8Array(0),
				reader: null,
			};
		}

		consumed.push(next.value);
		text += decoder.decode(next.value, { stream: true });

		const lines = text.split("\n");
		text = lines.pop() ?? "";
		for (const line of lines) {
			const outcome = considerQoderFrame(line);
			if (outcome?.error) {
				// The gateway holds the connection open after an error frame, so
				// stop here and release it rather than waiting for a close.
				void reader.cancel().catch(() => {});
				return {
					error: outcome.error,
					head: new Uint8Array(0),
					reader: null,
				};
			}
			if (outcome?.content) {
				return { error: null, head: head(), reader };
			}
		}
	}
}

/**
 * What one SSE line decides, if anything: an in-band error, the arrival of
 * content, or neither.
 */
function considerQoderFrame(
	line: string,
): { error?: QoderStreamError; content?: boolean } | null {
	const frame = qoderFrameToOpenAIChunk(line);
	if ("empty" in frame) return null;
	if (!frame.ok) return { error: frame.error };
	if (frame.chunk.choices?.length) return { content: true };
	return null;
}

/** A timeout marker, so a stalled read is distinguishable from a failed one. */
const TIMEOUT = Symbol("timeout");

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | typeof TIMEOUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMEOUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMEOUT), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Rebuild the upstream stream for the consumer: the bytes the peek consumed,
 * then the rest, read from the same reader.
 */
function relayQoderStream(
	head: Uint8Array,
	reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (head.length > 0) controller.enqueue(head);
		},
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel: (reason) => reader.cancel(reason),
	});
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
		// A duplicate-request rejection is the upstream refusing a RESEND, not a
		// malformed request — but it is a client-visible conflict, and the
		// Anthropic error types have no "conflict" member.
		case 409:
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
