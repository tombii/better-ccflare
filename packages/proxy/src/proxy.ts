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
