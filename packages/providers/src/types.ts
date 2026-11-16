import type { Account } from "@better-ccflare/types";
import type { ReasoningEffortTarget } from "./utils/reasoning-effort";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
}

export interface RateLimitInfo {
	isRateLimited: boolean;
	resetTime?: number;
	/**
	 * `resetTime` is a provider-side default rather than a window the upstream
	 * reported (Codex's one-hour fallback, Anthropic's 60s one). Callers that
	 * honour an explicit reset as the account's own quota window must treat an
	 * inferred one as "no signal" and keep the adaptive backoff instead —
	 * otherwise a bare 429 removes the account for an hour.
	 */
	resetIsInferred?: boolean;
	statusHeader?: string;
	remaining?: number;
}

export interface ProviderResponseContext {
	/** Model in the final request body sent upstream, after account mapping/fallback. */
	requestModel?: string | null;
	/**
	 * The `prepareRequest` state of the attempt that produced this response.
	 * Threaded back so providers can finish what they started without keeping
	 * per-request data on the shared account object.
	 */
	providerState?: ProviderRequestState;
}

/**
 * Opaque per-attempt provider state.
 *
 * A provider that has to carry information from `prepareRequest` (which runs
 * before the URL and headers exist) to `buildUrl`, `getTargetModel` and
 * `processResponse` returns it from `prepareRequest` instead of storing it on
 * the `Account`. Accounts are shared by concurrent requests, so account-level
 * storage lets one request's model leak into another's.
 *
 * The proxy treats the value as opaque: it only hands the same object back to
 * the provider on that attempt's later calls.
 */
export type ProviderRequestState = Record<string, unknown>;

export interface Provider {
	name: string;
	/** A configured native fallback model, available without an upstream lookup. */
	getDefaultModel?(): string | undefined;
	/** Passive request coverage, including refusal before an upstream dispatch. */
	observeRequest?(
		headers: Headers,
		nativeResponses: boolean,
	): RequestObservation | undefined;

	/** Passive metadata capture at the final dispatch boundary, once per actual
	 * upstream attempt. Must not change the request, retry, or consume quota. */
	observeUpstream?(
		request: Request,
		context: UpstreamObservationContext,
	): Promise<UpstreamObservation | undefined>;

	/**
	 * Check if this provider can handle the given request path
	 */
	canHandle(path: string): boolean;

	/**
	 * Refresh the access token for an account
	 */
	refreshToken(account: Account, clientId: string): Promise<TokenRefreshResult>;

	/**
	 * Build the target URL for the provider
	 * @param state - this attempt's state, as returned by `prepareRequest`
	 */
	buildUrl(
		path: string,
		query: string,
		account?: Account,
		state?: ProviderRequestState,
	): string;

	/**
	 * Optional: Pre-process the request before building URL
	 * This allows providers to extract information from the request body
	 * before buildUrl is called (e.g., for including model in URL path).
	 *
	 * @returns Optional per-attempt state. It is opaque to the proxy, which
	 *   hands the same value back to `buildUrl` and `getTargetModel` for this
	 *   attempt and, via `ProviderResponseContext.providerState`, to
	 *   `processResponse`. Providers must not store per-request data on the
	 *   shared account object.
	 */
	prepareRequest?(
		request: Request,
		requestBodyBuffer: ArrayBuffer | null,
		account: Account,
	): ProviderRequestState | undefined;

	/**
	 * Optional: the model the provider addressed in the URL it just built, for
	 * providers that remove `model` from the request body (Vertex AI). Lets the
	 * proxy report the model actually called upstream (the served-model
	 * response header) instead of the client's requested alias. Call it right
	 * after `buildUrl` with the same attempt's `state`.
	 */
	getTargetModel?(
		account: Account,
		state?: ProviderRequestState,
	): string | undefined;

	/**
	 * Prepare headers for the provider request
	 * @param headers - Original request headers
	 * @param accessToken - OAuth access token (for Bearer authentication)
	 * @param apiKey - API key (provider-specific header)
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers;

	/**
	 * Parse rate limit information from response
	 */
	parseRateLimit(response: Response): RateLimitInfo;

	/**
	 * Process the response before returning to client
	 */
	processResponse(
		response: Response,
		account: Account | null,
		requestHeaders?: Headers,
		drainAbort?: AbortController,
		context?: ProviderResponseContext,
	): Promise<Response>;

	/**
	 * Transform the request body before sending to the provider
	 */
	transformRequestBody?(request: Request, account?: Account): Promise<Request>;

	/**
	 * Whether the upstream THIS account talks to accepts an OpenRouter-style
	 * `provider` routing object. Optional: when absent the proxy falls back to
	 * the core provider-name list. Implement it when the target host decides
	 * (e.g. NanoGPT on a third-party custom endpoint is not NanoGPT).
	 */
	supportsProviderRoutingFor?(account?: Account): boolean;

	/**
	 * The native outbound field this provider uses for the client's reasoning
	 * effort; lets the proxy restore a dropped effort after a model fallback.
	 * Optional: a provider whose transform keeps the client's native shape
	 * untouched (Codex passthrough) leaves it unset.
	 */
	reasoningEffortTarget?(account?: Account): ReasoningEffortTarget | undefined;

	/**
	 * Extract tier information from response if available
	 */
	extractTierInfo?(response: Response): Promise<number | null>;

	/**
	 * Extract usage information from response if available
	 */
	extractUsageInfo?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

	/**
	 * Parse usage information from streaming SSE response if available
	 * This is called for streaming responses to extract usage from final SSE events
	 * Falls back to extractUsageInfo for non-streaming responses
	 */
	parseUsage?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;

	/**
	 * Check if the response is a streaming response
	 */
	isStreamingResponse?(response: Response): boolean;
}

export interface UpstreamObservationContext {
	requestId: string;
	account: Account | null;
	sourceBody: ArrayBuffer | null;
	sourceHeaders: Headers;
	nativeResponses: boolean;
	signal: AbortSignal;
}

export interface UpstreamObservation {
	response(response: Response): Response;
	error(error: unknown): void;
}

// OAuth-specific types
export interface OAuthProviderConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
	mode?: string;
}

export interface OAuthProvider {
	getOAuthConfig(mode?: string, redirectUri?: string): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
}

export interface PKCEChallenge {
	verifier: string;
	challenge: string;
}

export interface TokenResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
}

export interface RequestObservation extends UpstreamObservation {
	bindRequestId(requestId: string): void;
}
