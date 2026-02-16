import {
	requestEvents,
	ServiceUnavailableError,
	trackClientVersion,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	createRequestMetadata,
	ERROR_MESSAGES,
	interceptAndModifyRequest,
	isRefreshTokenLikelyExpired,
	type ProxyContext,
	prepareRequestBody,
	proxyUnauthenticated,
	proxyWithAccount,
	selectAccountsForRequest,
	TIMING,
	validateProviderPath,
} from "./handlers";
import { EMBEDDED_WORKER_CODE } from "./inline-worker";
import type { ControlMessage, OutgoingWorkerMessage } from "./worker-messages";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

// ===== WORKER MANAGEMENT =====

// Create usage worker instance
let usageWorkerInstance: Worker | null = null;
let shutdownTimerId: Timer | null = null;

/**
 * Gets or creates the usage worker instance
 * @returns The usage worker instance
 */
export function getUsageWorker(): Worker {
	if (!usageWorkerInstance) {
		try {
			// Check if we have embedded worker code (production build)
			if (EMBEDDED_WORKER_CODE) {
				// Decode the base64-encoded worker code
				const workerCode = Buffer.from(EMBEDDED_WORKER_CODE, "base64").toString(
					"utf8",
				);
				// Create a blob URL from the worker code
				const blob = new Blob([workerCode], { type: "text/javascript" });
				const workerUrl = URL.createObjectURL(blob);
				log.info("Post-processor worker starting from embedded code");
				usageWorkerInstance = new Worker(workerUrl, { smol: true });
				log.info("Post-processor worker started");
			} else {
				// Development: use TypeScript file
				const workerPath = new URL(
					"./post-processor.worker.ts",
					import.meta.url,
				).href;
				log.info(`Post-processor worker starting from: ${workerPath}`);
				usageWorkerInstance = new Worker(workerPath, { smol: true });
				log.info("Post-processor worker started");
			}

			// Bun extends Worker with unref method
			if (
				"unref" in usageWorkerInstance &&
				typeof usageWorkerInstance.unref === "function"
			) {
				usageWorkerInstance.unref(); // Don't keep process alive
			}

			// Listen for summary messages from worker
			usageWorkerInstance.onmessage = (ev) => {
				const data = ev.data as OutgoingWorkerMessage;
				if (data.type === "summary") {
					requestEvents.emit("event", {
						type: "summary",
						payload: data.summary,
					});
				}
			};

			// Handle worker errors
			usageWorkerInstance.onerror = (error: ErrorEvent) => {
				log.error("Worker error occurred in usage tracking system", {
					message: error.message,
					filename: error.filename,
					lineno: error.lineno,
					colno: error.colno,
					stack:
						error.error?.stack ||
						(error as ErrorEvent & { stack?: string }).stack,
					error: error.error,
					timestamp: new Date().toISOString(),
					workerType: "usage-worker",
					impact: "Usage statistics collection temporarily unavailable",
				});
				// Reset worker instance on error to allow recreation
				usageWorkerInstance = null;
			};
		} catch (error) {
			log.error("Failed to create worker:", error);
			throw error;
		}
	}
	return usageWorkerInstance;
}

/**
 * Gracefully terminates the usage worker
 */
export function terminateUsageWorker(): void {
	if (usageWorkerInstance) {
		// Clear any existing shutdown timer to prevent duplicate timeouts
		if (shutdownTimerId) {
			clearTimeout(shutdownTimerId);
			shutdownTimerId = null;
		}

		// Send shutdown message to allow worker to flush
		const shutdownMsg: ControlMessage = { type: "shutdown" };
		try {
			usageWorkerInstance.postMessage(shutdownMsg);
		} catch (_error) {
			// Worker already terminated, just clean up
			usageWorkerInstance = null;
			return;
		}

		// Give worker time to flush before terminating
		shutdownTimerId = setTimeout(() => {
			if (usageWorkerInstance) {
				try {
					usageWorkerInstance.terminate();
				} catch (_error) {
					// Ignore errors during termination
				}
				usageWorkerInstance = null;
			}
			shutdownTimerId = null;
		}, TIMING.WORKER_SHUTDOWN_DELAY);
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
 * @param apiKeyId - Optional API key ID for tracking
 * @param apiKeyName - Optional API key name for tracking
 * @returns Promise resolving to the proxied response
 * @throws {ValidationError} If the provider cannot handle the path
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	// 0. Silently ignore Claude Code internal endpoints (non-critical, not supported by all providers)
	if (
		url.pathname === "/api/event_logging/batch" ||
		url.pathname === "/api/system/package-manager"
	) {
		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// 1. Track client version from user-agent for use in auto-refresh
	trackClientVersion(req.headers.get("user-agent"));

	// 2. Validate provider can handle path
	validateProviderPath(ctx.provider, url.pathname);

	// 3. Prepare request body
	const { buffer: requestBodyBuffer } = await prepareRequestBody(req);

	// 3a. Validate request body for /v1/messages endpoint
	if (url.pathname === "/v1/messages" && requestBodyBuffer) {
		try {
			const bodyText = new TextDecoder().decode(requestBodyBuffer);
			const bodyJson = JSON.parse(bodyText);

			// Reject requests without messages field (e.g., Claude Code internal events)
			if (!bodyJson.messages || !Array.isArray(bodyJson.messages)) {
				log.warn(
					`Rejected invalid request to /v1/messages without messages field`,
					{
						event_type: bodyJson.event_type,
						event_name: bodyJson.event_data?.event_name,
					},
				);
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		} catch (error) {
			// If we can't parse the body, let it through and let the provider handle it
			log.debug("Could not parse request body for validation", error);
		}
	}

	// 4. Intercept and modify request for agent model preferences
	const { modifiedBody, agentUsed, originalModel, appliedModel } =
		await interceptAndModifyRequest(requestBodyBuffer, ctx.dbOps);

	// Use modified body if available
	const finalBodyBuffer = modifiedBody || requestBodyBuffer;
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};

	if (agentUsed && originalModel !== appliedModel) {
		log.info(
			`Agent ${agentUsed} detected, model changed from ${originalModel} to ${appliedModel}`,
		);
	}

	// 5. Create request metadata with agent info
	const requestMeta = createRequestMetadata(req, url);
	requestMeta.agentUsed = agentUsed;

	// 6. Select accounts
	const accounts = selectAccountsForRequest(requestMeta, ctx);

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		return proxyUnauthenticated(
			req,
			url,
			requestMeta,
			finalBodyBuffer,
			finalCreateBodyStream,
			ctx,
			apiKeyId,
			apiKeyName,
		);
	}

	// 8. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	if (
		process.env.DEBUG?.includes("proxy") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Request: ${req.method} ${url.pathname}`);
	}

	// 9. Try each account
	for (let i = 0; i < accounts.length; i++) {
		const response = await proxyWithAccount(
			req,
			url,
			accounts[i],
			requestMeta,
			finalBodyBuffer,
			finalCreateBodyStream,
			i,
			ctx,
			apiKeyId,
			apiKeyName,
		);

		if (response) {
			return response;
		}
	}

	// 10. All accounts failed - check if OAuth token issues are the cause
	const oauthAccounts = accounts.filter((acc) => acc.refresh_token);
	const needsReauth = oauthAccounts.filter((acc) =>
		isRefreshTokenLikelyExpired(acc),
	);

	if (needsReauth.length > 0) {
		// Quote account names to prevent command injection (defense-in-depth)
		const reauthCommands = needsReauth
			.map(
				(acc) =>
					`bun run cli --reauthenticate "${acc.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
			)
			.join("\n  ");
		throw new ServiceUnavailableError(
			`All accounts failed to proxy the request. OAuth tokens have expired for accounts: ${needsReauth.map((acc) => acc.name).join(", ")}.\n\nPlease re-authenticate:\n  ${reauthCommands}`,
			ctx.provider.name,
		);
	}

	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${accounts.length} attempted)`,
		ctx.provider.name,
	);
}
