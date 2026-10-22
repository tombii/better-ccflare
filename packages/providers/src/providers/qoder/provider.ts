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
import { buildCosyHeaders, deriveQoderMachineId, encodeQoderBody } from "./cosy";
import { buildQoderRequest } from "./request-builder";
import {
	aggregateQoderSse,
	qoderStatusForCode,
	unwrapQoderSse,
} from "./sse-unwrap";

const log = new Logger("QoderProvider");

export const QODER_DEFAULT_GATEWAY_ENDPOINT = "https://api3.qoder.sh";

const QODER_CHAT_PATH =
	"/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const QODER_MODEL_LIST_PATH = "/algo/api/v2/model/list";

// The proxy only materialises a synthetic response from a URL under
// `https://better-ccflare.local/` (SYNTHETIC_RESPONSE_URL_PREFIX), so the
// path segment after the origin is ours to choose.
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
		if (this.isSyntheticCountTokens(request)) {
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

		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) return request;
		if (!account) return request;

		const text = await request.text();

		// A request that is neither the client's JSON body nor this provider's
		// own encoded wire form: leave it alone, and do not fetch the identity
		// for a request that will not be sent.
		if (!tryParseJsonObject(text) && !request.headers.has(QODER_MODEL_HEADER)) {
			return request;
		}

		const decoded = decodeQoderAccessToken(account.access_token);
		if (!decoded?.token) {
			throw new Error(
				`Qoder account ${account.name} has no job token; refresh it before sending`,
			);
		}
		const identity = await this.ensureIdentity(account, decoded.token);

		// A request the proxy already transformed and is now replaying (in-place
		// retries on 529/5xx, model fallback, recovery paths). The body is the
		// encoded wire form, and the signature is only valid for one send — so
		// re-sign it rather than encoding it a second time.
		const replayedModel = request.headers.get(QODER_MODEL_HEADER);
		const body = tryParseJsonObject(text);
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
			body ? (body.stream === true ? "true" : "false") : streamIntentOf(request),
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
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: sanitizeHeaders(response.headers),
			});
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

		// In-band failures cannot reach the client as an Anthropic `error` event
		// from the shared emitter, so a stream that fails before producing
		// anything is reported as an error *response* by the aggregation path.
		// Peek at the stream's outcome lazily: if the first meaningful frame is
		// an error, take that path; otherwise hand the whole stream on.
		return transformStreamingResponse(unwrapQoderSse(response, { model }), {
			fallbackModel: model,
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
			const status =
				typeof (error as { status?: unknown }).status === "number"
					? (error as { status: number }).status
					: 502;
			const message = error instanceof Error ? error.message : String(error);
			log.warn(`Qoder stream failed for ${account?.name ?? "account"}`, {
				status,
				message: message.slice(0, 300),
			});
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: errorTypeForStatus(status),
						message,
					},
				}),
				{ status, headers: { "Content-Type": "application/json" } },
			);
		}
	}

	/**
	 * Qoder's in-band failures (quota, busy) are not HTTP statuses — the proxy
	 * needs this to bench an account for the right reason.
	 */
	async parseRateLimitFromBody(
		response: Response,
	): Promise<number | undefined> {
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("json")) return undefined;
		try {
			const body = (await response.clone().json()) as {
				code?: unknown;
				retry_after?: unknown;
				isQueued?: unknown;
			};
			if (body.code !== 10605 && body.isQueued !== true) return undefined;
			const seconds =
				typeof body.retry_after === "number" && body.retry_after > 0
					? body.retry_after
					: 30;
			return Date.now() + seconds * 1000;
		} catch {
			return undefined;
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

	/**
	 * The count_tokens request after the proxy has rewritten its URL. The
	 * dedicated synthetic URL is the pre-rewrite form used by direct callers.
	 */
	private isSyntheticCountTokens(request: Request): boolean {
		if (request.url === QODER_SYNTHETIC_COUNT_TOKENS_URL) return true;
		return request.url.includes(QODER_CHAT_PATH.split("?")[0]);
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
