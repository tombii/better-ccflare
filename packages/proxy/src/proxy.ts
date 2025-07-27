import crypto from "node:crypto";
import type { RuntimeConfig } from "@claudeflare/config";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
} from "@claudeflare/core";
import type { DatabaseOperations } from "@claudeflare/database";
import { Logger } from "@claudeflare/logger";
import type { Provider, TokenRefreshResult } from "@claudeflare/providers";

export interface ProxyContext {
	strategy: LoadBalancingStrategy;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	provider: Provider;
	refreshInFlight: Map<string, Promise<string>>;
}

const log = new Logger("Proxy");

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
				ctx.dbOps.updateAccountTokens(
					account.id,
					result.accessToken,
					result.expiresAt,
				);
				return result.accessToken;
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
		throw new Error(`Refresh promise not found for account ${account.id}`);
	}
	return promise;
}

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
	return await refreshAccessTokenSafe(account, ctx);
}

function getOrderedAccounts(meta: RequestMeta, ctx: ProxyContext): Account[] {
	const allAccounts = ctx.dbOps.getAllAccounts();
	// Filter accounts by provider
	const providerAccounts = allAccounts.filter(
		(account) =>
			account.provider === ctx.provider.name || account.provider === null,
	);
	return ctx.strategy.select(providerAccounts, meta);
}

export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
): Promise<Response> {
	const requestMeta: RequestMeta = {
		id: crypto.randomUUID(),
		method: req.method,
		path: url.pathname,
		timestamp: Date.now(),
	};

	// Check if provider can handle this request
	if (!ctx.provider.canHandle(url.pathname)) {
		return new Response(
			JSON.stringify({ error: "Provider cannot handle this request path" }),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const accounts = getOrderedAccounts(requestMeta, ctx);
	if (accounts.length === 0) {
		log.error("No active accounts available");
		ctx.dbOps.saveRequest(
			requestMeta.id,
			req.method,
			url.pathname,
			null,
			503,
			false,
			"No active accounts available",
			0,
			0,
		);
		return new Response(
			JSON.stringify({ error: "No active accounts available" }),
			{
				status: 503,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	log.info(
		`Selected ${accounts.length} accounts for request: ${accounts.map((a) => a.name).join(", ")}`,
	);

	// Try to read the body once for retries
	const requestBody = req.body ? await req.arrayBuffer() : null;

	// Try each account in order
	for (const account of accounts) {
		let lastError: string | null = null;
		let retryDelay = ctx.runtime.retry.delayMs;

		for (let retry = 0; retry < ctx.runtime.retry.attempts; retry++) {
			try {
				if (retry > 0) {
					log.info(
						`Retrying request with account: ${account.name} (attempt ${retry + 1}/${ctx.runtime.retry.attempts})`,
					);
					await new Promise((resolve) => setTimeout(resolve, retryDelay));
					retryDelay *= ctx.runtime.retry.backoff;
				} else {
					log.info(`Attempting request with account: ${account.name}`);
				}

				const accessToken = await getValidAccessToken(account, ctx);
				const headers = ctx.provider.prepareHeaders(req.headers, accessToken);
				const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);

				const response = await fetch(targetUrl, {
					method: req.method,
					headers: headers,
					body: requestBody,
					// @ts-ignore - Bun supports duplex
					duplex: "half",
				});

				// Update usage tracking
				ctx.dbOps.updateAccountUsage(account.id);

				// Clone response for body reading
				const responseClone = response.clone();

				// Check for rate limiting
				const rateLimitInfo = ctx.provider.checkRateLimit(response);
				if (rateLimitInfo.isRateLimited && rateLimitInfo.resetTime) {
					ctx.dbOps.markAccountRateLimited(account.id, rateLimitInfo.resetTime);
					lastError = `Rate limited until ${new Date(rateLimitInfo.resetTime).toISOString()}`;
					log.warn(
						`Account ${account.name} rate limited until ${new Date(rateLimitInfo.resetTime).toISOString()}`,
					);

					// Save rate limited response payload
					const responseBody = await responseClone
						.arrayBuffer()
						.catch(() => null);
					const payload = {
						request: {
							headers: Object.fromEntries(req.headers.entries()),
							body: requestBody
								? Buffer.from(requestBody).toString("base64")
								: null,
						},
						response: {
							status: response.status,
							headers: Object.fromEntries(response.headers.entries()),
							body: responseBody
								? Buffer.from(responseBody).toString("base64")
								: null,
						},
						meta: {
							accountId: account.id,
							retry,
							timestamp: Date.now(),
							rateLimited: true,
						},
					};
					ctx.dbOps.saveRequestPayload(requestMeta.id, payload);

					// Continue to next account immediately on rate limit
					break;
				}

				// Log successful request
				const responseTime = Date.now() - requestMeta.timestamp;
				ctx.dbOps.saveRequest(
					requestMeta.id,
					req.method,
					url.pathname,
					account.id,
					response.status,
					response.ok,
					null,
					responseTime,
					accounts.indexOf(account),
				);

				// Save successful response payload before processing
				const responseBody = await responseClone
					.arrayBuffer()
					.catch(() => null);
				const payload = {
					request: {
						headers: Object.fromEntries(req.headers.entries()),
						body: requestBody
							? Buffer.from(requestBody).toString("base64")
							: null,
					},
					response: {
						status: response.status,
						headers: Object.fromEntries(response.headers.entries()),
						body: responseBody
							? Buffer.from(responseBody).toString("base64")
							: null,
					},
					meta: {
						accountId: account.id,
						retry,
						timestamp: Date.now(),
						success: true,
					},
				};
				ctx.dbOps.saveRequestPayload(requestMeta.id, payload);

				// Check for tier information if provider supports it
				if (ctx.provider.extractTierInfo) {
					const tierInfo = await ctx.provider.extractTierInfo(
						response.clone() as Response,
					);
					if (tierInfo && tierInfo !== account.account_tier) {
						log.info(
							`Updating account ${account.name} tier from ${account.account_tier} to ${tierInfo}`,
						);
						ctx.dbOps.updateAccountTier(account.id, tierInfo);
					}
				}

				// Process and return the response
				return await ctx.provider.processResponse(response, account);
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				log.error(
					`Error proxying request with account ${account.name} (retry ${retry + 1}/${ctx.runtime.retry.attempts}):`,
					error,
				);

				// Save error payload
				const errorPayload = {
					request: {
						headers: Object.fromEntries(req.headers.entries()),
						body: requestBody
							? Buffer.from(requestBody).toString("base64")
							: null,
					},
					response: null,
					error: lastError,
					meta: {
						accountId: account.id,
						retry,
						timestamp: Date.now(),
						success: false,
					},
				};
				ctx.dbOps.saveRequestPayload(requestMeta.id, errorPayload);
			}
		}

		log.warn(`All retries failed for account ${account.name}: ${lastError}`);
	}

	// All accounts failed
	const responseTime = Date.now() - requestMeta.timestamp;
	ctx.dbOps.saveRequest(
		requestMeta.id,
		req.method,
		url.pathname,
		null,
		503,
		false,
		"All accounts failed",
		responseTime,
		accounts.length,
	);

	// Save final failure payload
	const failurePayload = {
		request: {
			headers: Object.fromEntries(req.headers.entries()),
			body: requestBody ? Buffer.from(requestBody).toString("base64") : null,
		},
		response: null,
		error: "All accounts failed",
		meta: {
			timestamp: Date.now(),
			success: false,
			accountsAttempted: accounts.length,
		},
	};
	ctx.dbOps.saveRequestPayload(requestMeta.id, failurePayload);

	return new Response(
		JSON.stringify({
			error: "All accounts failed to proxy the request",
			attempts: accounts.length,
			lastError: "All accounts failed",
		}),
		{
			status: 503,
			headers: { "Content-Type": "application/json" },
		},
	);
}
