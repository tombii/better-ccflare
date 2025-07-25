import crypto from "node:crypto";
import { Logger } from "./logger";
import type { LoadBalancingStrategy, RequestMeta, Account } from "./strategy";
import type { DatabaseOperations } from "./database";
import type { RuntimeConfig } from "./config";

export interface ProxyContext {
	strategy: LoadBalancingStrategy;
	dbOps: DatabaseOperations;
	runtime: RuntimeConfig;
	refreshInFlight: Map<string, Promise<string>>;
}

const log = new Logger("Proxy");

async function refreshAccessToken(
	account: Account,
	runtime: RuntimeConfig,
	dbOps: DatabaseOperations,
): Promise<string> {
	const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: account.refresh_token,
			client_id: runtime.clientId,
		}),
	});

	if (!response.ok) {
		throw new Error(
			`Failed to refresh token for account ${account.name}: ${response.statusText}`,
		);
	}

	const json = (await response.json()) as {
		access_token: string;
		expires_in: number;
	};
	const newAccessToken = json.access_token;
	const expiresAt = Date.now() + json.expires_in * 1000;

	dbOps.updateAccountTokens(account.id, newAccessToken, expiresAt);
	return newAccessToken;
}

async function refreshAccessTokenSafe(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// Check if a refresh is already in progress for this account
	if (!ctx.refreshInFlight.has(account.id)) {
		// Create a new refresh promise and store it
		const refreshPromise = refreshAccessToken(
			account,
			ctx.runtime,
			ctx.dbOps,
		).finally(() => {
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
	return ctx.strategy.select(allAccounts, meta);
}

// Strip Content-Encoding header so clients don't try to decompress already
// uncompressed streams (e.g. SSE) which can lead to `ZlibError` in Node / browsers
function stripContentEncoding(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.delete("content-encoding"); // lowercase
	headers.delete("Content-Encoding"); // fallback (case-insensitive safety)

	// Re-create a new Response object with the same body & status but without the
	// problematic header. Important: we must use `response.body` here – NOT a
	// clone that might already be consumed.
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
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
				const headers = new Headers(req.headers);
				headers.set("Authorization", `Bearer ${accessToken}`);
				headers.delete("host");
				// Remove compression headers to avoid decompression issues
				headers.delete("accept-encoding");
				headers.delete("content-encoding");

				const anthropicUrl = `https://api.anthropic.com${url.pathname}${url.search}`;
				const response = await fetch(anthropicUrl, {
					method: req.method,
					headers: headers,
					body: requestBody,
					// @ts-ignore - Bun supports duplex
					duplex: "half",
				});

				// Update usage tracking
				ctx.dbOps.updateAccountUsage(account.id);

				// Handle rate limiting
				if (response.status === 429) {
					const _retryAfter = response.headers.get("retry-after");
					const rateLimitReset = response.headers.get("x-ratelimit-reset");
					const resetTime = rateLimitReset
						? parseInt(rateLimitReset) * 1000
						: Date.now() + 60000;

					ctx.dbOps.markAccountRateLimited(account.id, resetTime);
					lastError = `Rate limited until ${new Date(resetTime).toISOString()}`;

					log.warn(
						`Account ${account.name} rate limited until ${new Date(resetTime).toISOString()}`,
					);

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

				// Clone response so we can inspect the JSON without consuming the
				// original stream that we will pass back to the caller.
				const responseClone = response.clone();

				// Check if this is a Max account and we should update tier
				if (account.provider === "anthropic") {
					try {
						const responseText = await responseClone.text();
						const responseJson = JSON.parse(responseText);

						// Check for tier information in response
						if (responseJson.type === "message" && responseJson.usage) {
							const usage = responseJson.usage;
							// Infer tier from rate limits if available
							if (usage.rate_limit_tokens) {
								const rateLimit = usage.rate_limit_tokens;
								let inferredTier = 1;
								if (rateLimit >= 800000) inferredTier = 20;
								else if (rateLimit >= 200000) inferredTier = 5;

								if (inferredTier !== account.account_tier) {
									log.info(
										`Updating account ${account.name} tier from ${account.account_tier} to ${inferredTier}`,
									);
									ctx.dbOps.updateAccountTier(account.id, inferredTier);
								}
							}
						}

						// Return new response (without Content-Encoding header)
						const headersOut = new Headers(response.headers);
						headersOut.delete("content-encoding");
						headersOut.delete("Content-Encoding");

						return new Response(responseText, {
							status: response.status,
							statusText: response.statusText,
							headers: headersOut,
						});
					} catch (_e) {
						// If parsing fails, return the original response but be
						// sure to strip the Content-Encoding header to avoid
						// decompression issues on the client.
						return stripContentEncoding(response);
					}
				}

				// Always strip Content-Encoding to avoid downstream zlib errors
				return stripContentEncoding(response);
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				log.error(
					`Error proxying request with account ${account.name} (retry ${retry + 1}/${ctx.runtime.retry.attempts}):`,
					error,
				);

				if (retry < ctx.runtime.retry.attempts - 1) {
				}
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
