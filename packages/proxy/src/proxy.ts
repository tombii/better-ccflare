import crypto from "node:crypto";
import type { RuntimeConfig } from "@claudeflare/config";
import {
	type Account,
	type LoadBalancingStrategy,
	logError,
	ProviderError,
	RateLimitError,
	type RequestMeta,
	ServiceUnavailableError,
	TokenRefreshError,
	ValidationError,
} from "@claudeflare/core";
import type { AsyncDbWriter, DatabaseOperations } from "@claudeflare/database";
import { Logger } from "@claudeflare/logger";
import type { Provider, TokenRefreshResult } from "@claudeflare/providers";
import { forwardToClient } from "./response-handler";
import type { ControlMessage } from "./worker-messages";

export interface ProxyContext {
	strategy: LoadBalancingStrategy;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	provider: Provider;
	refreshInFlight: Map<string, Promise<string>>;
	asyncWriter: AsyncDbWriter;
	usageWorker: Worker;
}

const log = new Logger("Proxy");

// ===== CONSTANTS =====

/** Error messages used throughout the proxy module */
const ERROR_MESSAGES = {
	NO_ACCOUNTS:
		"No active accounts available - forwarding request without authentication",
	PROVIDER_CANNOT_HANDLE: "Provider cannot handle path",
	REFRESH_NOT_FOUND: "Refresh promise not found for account",
	UNAUTHENTICATED_FAILED: "Failed to forward unauthenticated request",
	ALL_ACCOUNTS_FAILED: "All accounts failed to proxy the request",
	TOKEN_REFRESH_FAILED: "Failed to refresh access token",
	PROXY_REQUEST_FAILED: "Failed to proxy request with account",
} as const;

/** Timing constants */
const TIMING = {
	WORKER_SHUTDOWN_DELAY: 100, // ms
} as const;

/** HTTP headers used in proxy operations */
const _HEADERS = {
	CONTENT_TYPE: "Content-Type",
	AUTHORIZATION: "Authorization",
} as const;

// ===== WORKER MANAGEMENT =====

// Create usage worker instance
let usageWorkerInstance: Worker | null = null;

/**
 * Gets or creates the usage worker instance
 * @returns The usage worker instance
 */
export function getUsageWorker(): Worker {
	if (!usageWorkerInstance) {
		usageWorkerInstance = new Worker(
			new URL("./post-processor.worker.ts", import.meta.url).href,
			{ smol: true },
		);
		// Bun extends Worker with unref method
		if (
			"unref" in usageWorkerInstance &&
			typeof usageWorkerInstance.unref === "function"
		) {
			usageWorkerInstance.unref(); // Don't keep process alive
		}
	}
	return usageWorkerInstance;
}

/**
 * Gracefully terminates the usage worker
 */
export function terminateUsageWorker(): void {
	if (usageWorkerInstance) {
		// Send shutdown message to allow worker to flush
		const shutdownMsg: ControlMessage = { type: "shutdown" };
		usageWorkerInstance.postMessage(shutdownMsg);
		// Give worker time to flush before terminating
		setTimeout(() => {
			if (usageWorkerInstance) {
				usageWorkerInstance.terminate();
				usageWorkerInstance = null;
			}
		}, TIMING.WORKER_SHUTDOWN_DELAY);
	}
}

// ===== TOKEN MANAGEMENT =====

/**
 * Safely refreshes an access token with deduplication
 * @param account - The account to refresh token for
 * @param ctx - The proxy context
 * @returns Promise resolving to the new access token
 * @throws {TokenRefreshError} If token refresh fails
 * @throws {ServiceUnavailableError} If refresh promise is not found
 */
async function refreshAccessTokenSafe(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// Check if a refresh is already in progress for this account
	if (!ctx.refreshInFlight.has(account.id)) {
		// Create a new refresh promise and store it
		const refreshPromise = ctx.provider
			.refreshToken(account, ctx.runtime.clientId)
			.then((result: TokenRefreshResult) => {
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateAccountTokens(
						account.id,
						result.accessToken,
						result.expiresAt,
						result.refreshToken,
					),
				);
				return result.accessToken;
			})
			.catch((error) => {
				throw new TokenRefreshError(account.id, error as Error);
			})
			.finally(() => {
				// Clean up the map when done (success or failure)
				ctx.refreshInFlight.delete(account.id);
			});
		ctx.refreshInFlight.set(account.id, refreshPromise);
	}

	// Return the existing or new refresh promise
	const promise = ctx.refreshInFlight.get(account.id);
	if (!promise) {
		throw new ServiceUnavailableError(
			`${ERROR_MESSAGES.REFRESH_NOT_FOUND} ${account.id}`,
		);
	}
	return promise;
}

/**
 * Gets a valid access token for an account, refreshing if necessary
 * @param account - The account to get token for
 * @param ctx - The proxy context
 * @returns Promise resolving to a valid access token
 */
async function getValidAccessToken(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	if (
		account.access_token &&
		account.expires_at &&
		account.expires_at > Date.now()
	) {
		return account.access_token;
	}
	log.info(`Token expired or missing for account: ${account.name}`);
	return await refreshAccessTokenSafe(account, ctx);
}

// ===== ACCOUNT SELECTION =====

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
function getOrderedAccounts(meta: RequestMeta, ctx: ProxyContext): Account[] {
	const allAccounts = ctx.dbOps.getAllAccounts();
	// Filter accounts by provider
	const providerAccounts = allAccounts.filter(
		(account) =>
			account.provider === ctx.provider.name || account.provider === null,
	);
	return ctx.strategy.select(providerAccounts, meta);
}

/**
 * Selects accounts for a request based on the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of selected accounts
 */
function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
): Account[] {
	return getOrderedAccounts(meta, ctx);
}

// ===== REQUEST PREPARATION =====

/**
 * Creates request metadata for tracking and analytics
 * @param req - The incoming request
 * @param url - The parsed URL
 * @returns Request metadata object
 */
function createRequestMetadata(req: Request, url: URL): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: req.method,
		path: url.pathname,
		timestamp: Date.now(),
	};
}

/**
 * Validates that the provider can handle the requested path
 * @param provider - The provider instance
 * @param pathname - The request path
 * @throws {ValidationError} If provider cannot handle the path
 */
function validateProviderPath(provider: Provider, pathname: string): void {
	if (!provider.canHandle(pathname)) {
		throw new ValidationError(
			`${ERROR_MESSAGES.PROVIDER_CANNOT_HANDLE}: ${pathname}`,
			"path",
			pathname,
		);
	}
}

/**
 * Prepares request body for analytics and creates body stream factory
 * @param req - The incoming request
 * @returns Object containing the buffered body and stream factory
 */
async function prepareRequestBody(req: Request): Promise<{
	buffer: ArrayBuffer | null;
	createStream: () => ReadableStream<Uint8Array> | undefined;
}> {
	let buffer: ArrayBuffer | null = null;

	if (req.body) {
		buffer = await req.arrayBuffer();
	}

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

// ===== PROXY OPERATIONS =====

/**
 * Makes the actual HTTP request to the provider
 * @param targetUrl - The target URL to fetch
 * @param method - HTTP method
 * @param headers - Request headers
 * @param createBodyStream - Function to create request body stream
 * @param hasBody - Whether the request has a body
 * @returns Promise resolving to the response
 */
async function makeProxyRequest(
	targetUrl: string,
	method: string,
	headers: Headers,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	hasBody: boolean,
): Promise<Response> {
	return fetch(targetUrl, {
		method,
		headers,
		body: createBodyStream(),
		...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
	});
}

/**
 * Handles proxy request without authentication
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param ctx - The proxy context
 * @returns Promise resolving to the response
 * @throws {ProviderError} If the unauthenticated request fails
 */
async function proxyUnauthenticated(
	req: Request,
	url: URL,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	ctx: ProxyContext,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);
	const headers = ctx.provider.prepareHeaders(req.headers);

	try {
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);

		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);
	} catch (error) {
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.provider.name,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

// ===== RESPONSE HANDLING =====

/**
 * Handles rate limit response for an account
 * @param account - The rate-limited account
 * @param rateLimitInfo - Parsed rate limit information
 * @param ctx - The proxy context
 */
function handleRateLimitResponse(
	account: Account,
	rateLimitInfo: ReturnType<Provider["parseRateLimit"]>,
	ctx: ProxyContext,
): void {
	if (!rateLimitInfo.resetTime) return;

	log.warn(
		`Account ${account.name} rate-limited until ${new Date(
			rateLimitInfo.resetTime,
		).toISOString()}`,
	);

	const resetTime = rateLimitInfo.resetTime;
	ctx.asyncWriter.enqueue(() =>
		ctx.dbOps.markAccountRateLimited(account.id, resetTime),
	);

	const rateLimitError = new RateLimitError(
		account.id,
		rateLimitInfo.resetTime,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}

/**
 * Updates account metadata in the background
 * @param account - The account to update
 * @param response - The response to extract metadata from
 * @param ctx - The proxy context
 */
function updateAccountMetadata(
	account: Account,
	response: Response,
	ctx: ProxyContext,
): void {
	// Update basic usage
	ctx.asyncWriter.enqueue(() => ctx.dbOps.updateAccountUsage(account.id));

	// Extract tier info if supported
	if (ctx.provider.extractTierInfo) {
		const extractTierInfo = ctx.provider.extractTierInfo.bind(ctx.provider);
		(async () => {
			const tier = await extractTierInfo(response.clone() as Response);
			if (tier && tier !== account.account_tier) {
				log.info(
					`Updating account ${account.name} tier from ${account.account_tier} to ${tier}`,
				);
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateAccountTier(account.id, tier),
				);
			}
		})();
	}
}

/**
 * Processes a successful proxy response
 * @param response - The provider response
 * @param account - The account used
 * @param ctx - The proxy context
 * @returns Whether the response is rate-limited
 */
function processProxyResponse(
	response: Response,
	account: Account,
	ctx: ProxyContext,
): boolean {
	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	const rateLimitInfo = ctx.provider.parseRateLimit(response);

	// Handle rate limit
	if (!isStream && rateLimitInfo.isRateLimited && rateLimitInfo.resetTime) {
		handleRateLimitResponse(account, rateLimitInfo, ctx);
		return true; // Signal rate limit
	}

	// Update account metadata in background
	updateAccountMetadata(account, response, ctx);
	return false;
}

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @returns Promise resolving to response or null if failed
 */
async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	failoverAttempts: number,
	ctx: ProxyContext,
): Promise<Response | null> {
	try {
		log.info(`Attempting request with account: ${account.name}`);

		// Get valid access token
		const accessToken = await getValidAccessToken(account, ctx);

		// Prepare request
		const headers = ctx.provider.prepareHeaders(req.headers, accessToken);
		const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);

		// Make the request
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
		);

		// Process response and check for rate limit
		const isRateLimited = processProxyResponse(response, account, ctx);
		if (isRateLimited) {
			return null; // Signal to try next account
		}

		// Forward response to client
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts,
			},
			ctx,
		);
	} catch (err) {
		handleProxyError(err, account, log);
		return null;
	}
}

/**
 * Handles errors that occur during proxy operations
 * @param error - The error that occurred
 * @param account - The account that failed (optional)
 * @param logger - Logger instance
 */
function handleProxyError(
	error: unknown,
	account: Account | null,
	logger: Logger,
): void {
	logError(error, logger);
	if (account) {
		logger.error(`Failed to proxy request with account ${account.name}`);
	} else {
		logger.error("Failed to proxy request");
	}
}

// ===== MAIN HANDLER =====

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Validating the provider can handle the path
 * 3. Preparing the request body for reuse
 * 4. Selecting accounts based on load balancing strategy
 * 5. Attempting to proxy with each account in order
 * 6. Falling back to unauthenticated proxy if no accounts available
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @returns Promise resolving to the proxied response
 * @throws {ValidationError} If the provider cannot handle the path
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
): Promise<Response> {
	// 1. Create request metadata
	const requestMeta = createRequestMetadata(req, url);

	// 2. Validate provider can handle path
	validateProviderPath(ctx.provider, url.pathname);

	// 3. Prepare request body
	const { buffer: requestBodyBuffer, createStream: createBodyStream } =
		await prepareRequestBody(req);

	// 4. Select accounts
	const accounts = selectAccountsForRequest(requestMeta, ctx);

	// 5. Handle no accounts case
	if (accounts.length === 0) {
		return proxyUnauthenticated(
			req,
			url,
			requestMeta,
			requestBodyBuffer,
			createBodyStream,
			ctx,
		);
	}

	// 6. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	log.info(`Request: ${req.method} ${url.pathname}`);

	// 7. Try each account
	for (let i = 0; i < accounts.length; i++) {
		const response = await proxyWithAccount(
			req,
			url,
			accounts[i],
			requestMeta,
			requestBodyBuffer,
			createBodyStream,
			i,
			ctx,
		);

		if (response) {
			return response;
		}
	}

	// 8. All accounts failed
	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${accounts.length} attempted)`,
		ctx.provider.name,
	);
}
