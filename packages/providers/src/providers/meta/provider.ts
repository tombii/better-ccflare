import { mapModelName } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { RateLimitInfo } from "../../types";
import { transformRequestBodyModel } from "../../utils/model-mapping";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";
import { sanitizeMetaRequestBody } from "./request-sanitizer";

const log = new Logger("MetaProvider");

/** Meta Model API base for the Anthropic-compatible Messages surface. */
export const META_DEFAULT_ENDPOINT = "https://api.meta.ai";

/** Current standard-tier checkpoint. */
export const META_DEFAULT_MODEL = "muse-spark-1.2";

/** Model IDs the Meta Model API publishes. */
export const META_MODEL_IDS = {
	MUSE_SPARK_1_1: "muse-spark-1.1",
	MUSE_SPARK_1_2: "muse-spark-1.2",
	MUSE_SPARK_1_2_CONTRIBUTOR: "muse-spark-1.2-contributor",
} as const;

/**
 * Default logical-family routing. Meta serves one model per tier, so every
 * Claude family collapses onto the current standard checkpoint — the same
 * shape as Meta's own Claude Code setup, which points OPUS, SONNET and HAIKU
 * at a single model ID.
 */
export const META_MODEL_MAPPINGS: Record<string, string> = {
	opus: META_DEFAULT_MODEL,
	sonnet: META_DEFAULT_MODEL,
	haiku: META_DEFAULT_MODEL,
};

/** Whether a model ID already names a Meta checkpoint. */
export function isMetaModel(model: string): boolean {
	return model.trim().toLowerCase().startsWith("muse-spark");
}

/**
 * Whether a request targets the Anthropic Messages surface (`/v1/messages` or
 * `/v1/messages/count_tokens`), the only endpoints whose body follows the
 * contract the request sanitizer enforces.
 *
 * Matched as a suffix, not an exact path: the proxy builds the downstream
 * request from the already-rewritten target URL, so behind a path-prefixed
 * gateway this sees `/proxy/v1/messages`. An exact match would silently skip
 * sanitization for exactly the accounts that still need it.
 */
export function isMetaMessagesPath(url: string): boolean {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		pathname = url.split("?")[0];
	}
	pathname = pathname.replace(/\/$/, "");
	return (
		pathname.endsWith("/v1/messages") ||
		pathname.endsWith("/v1/messages/count_tokens")
	);
}

/**
 * Join a base URL path with a request path, collapsing any overlap between the
 * base's trailing segments and the request's leading ones.
 *
 * A gateway base may carry its own prefix and its own `/v1` (for example
 * `https://gateway.example/proxy/v1`). Comparing the whole base path would miss
 * that, producing `/proxy/v1/v1/messages` and routing a valid configuration to
 * an endpoint that does not exist.
 */
export function joinMetaPath(basePath: string, pathname: string): string {
	const baseSegments = basePath.split("/").filter(Boolean);
	const pathSegments = pathname.split("/").filter(Boolean);

	let overlap = 0;
	for (
		let size = Math.min(baseSegments.length, pathSegments.length);
		size > 0;
		size--
	) {
		const baseTail = baseSegments.slice(baseSegments.length - size);
		const pathHead = pathSegments.slice(0, size);
		if (baseTail.every((segment, i) => segment === pathHead[i])) {
			overlap = size;
			break;
		}
	}

	const joined = [...baseSegments, ...pathSegments.slice(overlap)];
	return joined.length > 0 ? `/${joined.join("/")}` : "/";
}

export class MetaProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "meta",
			baseUrl: META_DEFAULT_ENDPOINT,
			// Meta authenticates with a bearer token, not Anthropic's x-api-key.
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
			defaultModel: META_DEFAULT_MODEL,
		});
	}

	getEndpoint(): string {
		return this.config.baseUrl || META_DEFAULT_ENDPOINT;
	}

	/**
	 * Meta serves the Messages API at `<base>/v1/messages`. A custom endpoint is
	 * honoured so the account can be pointed at a gateway or regional host, and
	 * any overlap between the base's trailing path and the request path is
	 * collapsed, so neither `.../v1` nor `.../proxy/v1` yields a duplicate `/v1`.
	 *
	 * The result is assembled through the parsed URL rather than by string
	 * concatenation: a gateway base may legitimately carry its own query string
	 * (`https://gateway.example/proxy?api-version=2024`), and appending the route
	 * as text would bury it inside that query and leave the path at `/proxy`.
	 * Base query parameters are preserved and the request's own take precedence.
	 */
	buildUrl(pathname: string, search: string, account?: Account): string {
		const baseUrl = account?.custom_endpoint?.trim() || this.getEndpoint();
		const cleanBaseUrl = baseUrl.replace(/\/$/, "");

		try {
			const target = new URL(cleanBaseUrl);
			target.pathname = joinMetaPath(
				target.pathname.replace(/\/$/, ""),
				pathname,
			);

			const requestParams = new URLSearchParams(
				search.startsWith("?") ? search.slice(1) : search,
			);
			for (const [key, value] of requestParams) {
				target.searchParams.set(key, value);
			}
			// A fragment is meaningless to the upstream and never sent anyway.
			target.hash = "";

			return target.toString();
		} catch {
			return `${cleanBaseUrl}${pathname}${search}`;
		}
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);
		const token = accessToken || apiKey;

		if (token) {
			// Drop any client-supplied credential before attaching ours.
			newHeaders.delete("authorization");
			newHeaders.delete("x-api-key");
			newHeaders.set("Authorization", `Bearer ${token}`);
		}

		// The sanitizer rewrites the body, so any inbound length is stale. The
		// openai and codex providers strip it for the same reason.
		newHeaders.delete("content-length");
		newHeaders.delete("host");
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");

		return newHeaders;
	}

	/**
	 * Resolve the outbound model ID.
	 *
	 * An explicit account mapping always wins. Otherwise a Claude model name is
	 * routed to the default Meta checkpoint, because forwarding
	 * `claude-*` unchanged is a guaranteed `model_not_found`.
	 */
	resolveModel(model: string, account?: Account): string {
		if (!model) return model;

		if (account) {
			const mapped = mapModelName(model, account);
			if (mapped && mapped !== model) return mapped;
		}

		if (isMetaModel(model)) return model;

		return this.config.defaultModel || META_DEFAULT_MODEL;
	}

	/**
	 * Map the model and normalise the body for Meta's strict validator.
	 *
	 * The body is read with `arrayBuffer()` rather than `request.clone()`: on a
	 * body-bearing Request, Bun buffers the whole body natively to feed the tee
	 * and never returns that buffer to the OS, leaking ~1x the body size on
	 * every proxied request. Because the original body is consumed here, callers
	 * must forward the returned Request.
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return request;
		}

		// Other JSON endpoints retain their own schema.
		if (!isMetaMessagesPath(request.url)) {
			return transformRequestBodyModel(request);
		}

		// Sanitization changes the body length, so the inbound content-length must
		// not ride along: reusing it sends wrong framing and the outgoing fetch can
		// reject the request before Meta ever sees it. Deleting it lets the length
		// be recomputed from the actual bytes.
		const rebuild = (body: BodyInit): Request => {
			const headers = new Headers(request.headers);
			headers.delete("content-length");
			return new Request(request.url, {
				method: request.method,
				headers,
				body,
			});
		};

		let bytes: ArrayBuffer;
		try {
			bytes = await request.arrayBuffer();
		} catch (error) {
			log.debug("Failed to read request body for Meta:", error);
			return request;
		}

		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return rebuild(bytes);
			}

			const body = parsed as Record<string, unknown>;

			if (typeof body.model === "string") {
				const mapped = this.resolveModel(body.model, account);
				if (mapped !== body.model) {
					log.debug(`Mapped model: ${body.model} -> ${mapped}`);
					body.model = mapped;
				}
			}

			const { body: sanitized, changes } = sanitizeMetaRequestBody(body);
			if (changes.length > 0) {
				log.debug(
					`Sanitized request for Meta Model API: ${changes.join(", ")}`,
				);
			}

			return rebuild(JSON.stringify(sanitized));
		} catch (error) {
			log.debug("Failed to transform Meta request body:", error);
			return rebuild(bytes);
		}
	}

	/**
	 * Meta reports quota with OpenAI-style `x-ratelimit-*` headers rather than
	 * Anthropic's `anthropic-ratelimit-unified-*` set, so the base class parser
	 * would see nothing on a successful response.
	 */
	parseRateLimit(response: Response): RateLimitInfo {
		const remainingRequests = response.headers.get(
			"x-ratelimit-remaining-requests",
		);
		const remainingTokens = response.headers.get(
			"x-ratelimit-remaining-tokens",
		);

		const parseCount = (value: string | null): number | undefined => {
			if (value === null) return undefined;
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : undefined;
		};

		// Requests-remaining is the actionable signal for account selection;
		// fall back to tokens when the request budget is not reported.
		const remaining =
			parseCount(remainingRequests) ?? parseCount(remainingTokens);

		if (response.status !== 429) {
			// Response metadata is only persisted when a status is present, so
			// headroom parsed from a healthy response would otherwise be discarded
			// and the account's remaining quota would stay null or stale. "allowed"
			// is the same marker the qwen and openai providers use, and is not a
			// hard-limit status. Only claim it when Meta actually reported quota.
			return remaining === undefined
				? { isRateLimited: false }
				: {
						isRateLimited: false,
						statusHeader: "allowed",
						remaining,
					};
		}

		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;
		if (retryAfter) {
			const seconds = Number(retryAfter);
			resetTime = Number.isNaN(seconds)
				? new Date(retryAfter).getTime()
				: Date.now() + seconds * 1000;
			if (Number.isNaN(resetTime)) resetTime = undefined;
		}

		return {
			isRateLimited: true,
			resetTime,
			statusHeader: "rate_limited",
			remaining,
		};
	}
}
