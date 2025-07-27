import crypto from "node:crypto";
import type { RuntimeConfig } from "@claudeflare/config";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
} from "@claudeflare/core";
import { estimateCostUSD, NO_ACCOUNT_ID } from "@claudeflare/core";
import type { DatabaseOperations } from "@claudeflare/database";
import { Logger } from "@claudeflare/logger";
import type { Provider, TokenRefreshResult } from "@claudeflare/providers";
import { combineChunks, teeStream } from "./stream-tee";

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
	log.info(`Token expired or missing for account: ${account.name}`);
	return await refreshAccessTokenSafe(account, ctx);
}

async function saveUsageToDb(
	requestId: string,
	accountId: string | null,
	usage?: {
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null,
	ctx?: ProxyContext,
): Promise<void> {
	if (!usage || !ctx) return;

	// Calculate cost if not provided
	if (usage.model && usage.costUsd === undefined) {
		usage.costUsd = await estimateCostUSD(usage.model, {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadInputTokens: usage.cacheReadInputTokens,
			cacheCreationInputTokens: usage.cacheCreationInputTokens,
		});
	}

	// Update the existing request record with usage information
	ctx.dbOps.updateRequestUsage(requestId, usage);

	if (accountId && accountId !== NO_ACCOUNT_ID) {
		log.info(
			`Usage for request ${requestId}: Model: ${usage.model}, Tokens: ${usage.totalTokens || 0}, Cost: $${usage.costUsd?.toFixed(4) || "0"}`,
		);
	}
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
	const fallbackUnauthenticated = accounts.length === 0;

	if (fallbackUnauthenticated) {
		log.warn(
			"No active accounts available - forwarding request without authentication",
		);
	} else {
		log.info(
			`Selected ${accounts.length} accounts for request: ${accounts.map((a) => a.name).join(", ")}`,
		);
		log.info(`Request: ${req.method} ${url.pathname}`);
	}

	// Try to read the body once for retries
	const requestBody = req.body ? await req.arrayBuffer() : null;

	// Handle unauthenticated fallback
	if (fallbackUnauthenticated) {
		const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);
		const headers = ctx.provider.prepareHeaders(req.headers); // No access token
		const start = Date.now();

		try {
			const response = await fetch(targetUrl, {
				method: req.method,
				headers: headers,
				body: requestBody,
				// @ts-ignore - Bun supports duplex
				duplex: "half",
			});

			const responseTime = Date.now() - start;
			const responseClone = response.clone();

			log.info(
				`Unauthenticated request completed: ${response.status} in ${responseTime}ms`,
			);

			// Parse rate limit information even for unauthenticated requests
			const rateLimitInfo = ctx.provider.parseRateLimit(response);
			// Note: We can't update account metadata since there's no account
			log.info(
				`Rate limit for unauthenticated request: ${rateLimitInfo.statusHeader} - Remaining: ${rateLimitInfo.remaining}`,
			);

			// Extract usage info if provider supports it
			let usage:
				| {
						model?: string;
						promptTokens?: number;
						completionTokens?: number;
						totalTokens?: number;
						costUsd?: number;
						inputTokens?: number;
						cacheReadInputTokens?: number;
						cacheCreationInputTokens?: number;
						outputTokens?: number;
				  }
				| null
				| undefined;

			// Check if this is a streaming response
			const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

			if (ctx.provider.extractUsageInfo && response.ok) {
				const extractPromise = ctx.provider
					.extractUsageInfo(responseClone as Response)
					.catch(() => null);

				if (isStream) {
					// Fire-and-forget for streaming responses
					extractPromise.then((extractedUsage) => {
						saveUsageToDb(requestMeta.id, NO_ACCOUNT_ID, extractedUsage, ctx);
					});
				} else {
					// Wait for non-streaming responses
					usage = await extractPromise;
					// Calculate cost if not provided by headers
					if (usage?.model && usage.costUsd === undefined) {
						usage.costUsd = await estimateCostUSD(usage.model, {
							inputTokens: usage.inputTokens,
							outputTokens: usage.outputTokens,
							cacheReadInputTokens: usage.cacheReadInputTokens,
							cacheCreationInputTokens: usage.cacheCreationInputTokens,
						});
					}
				}
			}

			// Save request to database
			ctx.dbOps.saveRequest(
				requestMeta.id,
				req.method,
				url.pathname,
				NO_ACCOUNT_ID,
				response.status,
				response.ok,
				null,
				responseTime,
				0,
				usage || undefined,
			);

			// Save response payload (skip body for streaming responses)
			const responseBody = isStream
				? null
				: await responseClone.arrayBuffer().catch(() => null);
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
					accountId: NO_ACCOUNT_ID,
					timestamp: Date.now(),
					success: response.ok,
					isStream,
				},
			};
			ctx.dbOps.saveRequestPayload(requestMeta.id, payload);

			// Process and return the response
			if (isStream && response.body) {
				// Use tee to capture streaming response
				let payloadSaved = false;
				const teedStream = teeStream(response.body, {
					maxBytes: ctx.runtime.streamBodyMaxBytes,
					onClose: (buffered) => {
						if (!payloadSaved) {
							payloadSaved = true;
							const combined = combineChunks(buffered);
							const updatedPayload = {
								...payload,
								response: {
									...payload.response,
									body:
										combined.length > 0 ? combined.toString("base64") : null,
								},
								meta: {
									...payload.meta,
									bodyTruncated:
										buffered.length > 0 &&
										combined.length >= ctx.runtime.streamBodyMaxBytes,
								},
							};
							// Update the payload with the streamed body
							ctx.dbOps.saveRequestPayload(requestMeta.id, updatedPayload);
						}
					},
					onError: (error) => {
						log.error(
							`Error capturing stream for unauthenticated request: ${error.message}`,
						);
					},
				});

				const newResponse = new Response(teedStream, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
				return await ctx.provider.processResponse(newResponse, null);
			}
			return await ctx.provider.processResponse(response, null);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			log.error("Error forwarding unauthenticated request:", error);

			// Save error to database
			ctx.dbOps.saveRequest(
				requestMeta.id,
				req.method,
				url.pathname,
				NO_ACCOUNT_ID,
				0,
				false,
				errorMessage,
				Date.now() - start,
				0,
				undefined,
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
				error: errorMessage,
				meta: {
					accountId: NO_ACCOUNT_ID,
					timestamp: Date.now(),
					success: false,
				},
			};
			ctx.dbOps.saveRequestPayload(requestMeta.id, errorPayload);

			// Return error response
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 502,
				headers: { "Content-Type": "application/json" },
			});
		}
	}

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

				const start = Date.now();
				const response = await fetch(targetUrl, {
					method: req.method,
					headers: headers,
					body: requestBody,
					// @ts-ignore - Bun supports duplex
					duplex: "half",
				});

				// Update usage tracking
				ctx.dbOps.updateAccountUsage(account.id);

				const _responseTime = Date.now() - start;
				log.info(
					`Request completed for ${account.name}: ${response.status} in ${_responseTime}ms`,
				);

				// Clone response for body reading
				const responseClone = response.clone();

				// Check if this is a streaming response
				const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

				// Parse rate limit information from all responses
				const rateLimitInfo = ctx.provider.parseRateLimit(response);

				// Update rate limit metadata if available
				if (rateLimitInfo.statusHeader || rateLimitInfo.resetTime) {
					log.info(
						`Rate limit for ${account.name}: ${rateLimitInfo.statusHeader} - Remaining: ${rateLimitInfo.remaining}`,
					);
					ctx.dbOps.updateAccountRateLimitMeta(
						account.id,
						rateLimitInfo.statusHeader || "",
						rateLimitInfo.resetTime || null,
						rateLimitInfo.remaining,
					);
				}

				// Handle hard rate limiting (status != allowed or 429)
				if (rateLimitInfo.isRateLimited && rateLimitInfo.resetTime) {
					ctx.dbOps.markAccountRateLimited(account.id, rateLimitInfo.resetTime);
					lastError = `Rate limited until ${new Date(rateLimitInfo.resetTime).toISOString()}`;
					log.warn(
						`Account ${account.name} rate limited until ${new Date(rateLimitInfo.resetTime).toISOString()}`,
					);

					// Save rate limited response payload (skip body for streaming responses)
					const responseBody = isStream
						? null
						: await responseClone.arrayBuffer().catch(() => null);
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
							isStream,
						},
					};
					ctx.dbOps.saveRequestPayload(requestMeta.id, payload);

					// Continue to next account immediately on rate limit
					break;
				}

				// Extract usage info if provider supports it
				let usage:
					| {
							model?: string;
							promptTokens?: number;
							completionTokens?: number;
							totalTokens?: number;
							costUsd?: number;
							inputTokens?: number;
							cacheReadInputTokens?: number;
							cacheCreationInputTokens?: number;
							outputTokens?: number;
					  }
					| null
					| undefined;

				if (ctx.provider.extractUsageInfo && response.ok) {
					const extractPromise = ctx.provider
						.extractUsageInfo(responseClone as Response)
						.catch(() => null);

					if (isStream) {
						// Fire-and-forget for streaming responses
						extractPromise.then((extractedUsage) => {
							if (extractedUsage) {
								log.info(
									`Usage for ${account.name}: Model: ${extractedUsage.model}, Tokens: ${extractedUsage.totalTokens || 0}, Cost: $${extractedUsage.costUsd?.toFixed(4) || "0"}`,
								);
							}
							saveUsageToDb(requestMeta.id, account.id, extractedUsage, ctx);
						});
					} else {
						// Wait for non-streaming responses
						usage = await extractPromise;
						if (usage) {
							log.info(
								`Usage for ${account.name}: Model: ${usage.model}, Tokens: ${usage.totalTokens || 0}, Cost: $${usage.costUsd?.toFixed(4) || "0"}`,
							);
						}
						// Calculate cost if not provided by headers
						if (usage?.model && usage.costUsd === undefined) {
							usage.costUsd = await estimateCostUSD(usage.model, {
								inputTokens: usage.inputTokens,
								outputTokens: usage.outputTokens,
								cacheReadInputTokens: usage.cacheReadInputTokens,
								cacheCreationInputTokens: usage.cacheCreationInputTokens,
							});
						}
					}
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
					usage || undefined,
				);

				// Save successful response payload before processing (skip body for streaming responses)
				const responseBody = isStream
					? null
					: await responseClone.arrayBuffer().catch(() => null);
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
						isStream,
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
				if (isStream && response.body) {
					// Use tee to capture streaming response
					let payloadSaved = false;
					const teedStream = teeStream(response.body, {
						maxBytes: ctx.runtime.streamBodyMaxBytes,
						onClose: (buffered) => {
							if (!payloadSaved) {
								payloadSaved = true;
								const combined = combineChunks(buffered);
								const updatedPayload = {
									...payload,
									response: {
										...payload.response,
										body:
											combined.length > 0 ? combined.toString("base64") : null,
									},
									meta: {
										...payload.meta,
										bodyTruncated:
											buffered.length > 0 &&
											combined.length >= ctx.runtime.streamBodyMaxBytes,
									},
								};
								// Update the payload with the streamed body
								ctx.dbOps.saveRequestPayload(requestMeta.id, updatedPayload);
							}
						},
						onError: (error) => {
							log.error(
								`Error capturing stream for ${account.name}: ${error.message}`,
							);
						},
					});

					const newResponse = new Response(teedStream, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
					return await ctx.provider.processResponse(newResponse, account);
				}
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
		undefined,
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
