import https from "node:https";
import type { Config } from "@better-ccflare/config";
import { registerHeartbeat } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { cacheBodyStore } from "./cache-body-store";
import type { ProxyContext } from "./proxy";

const log = new Logger("CacheKeepaliveScheduler");

/**
 * Patch a staged request body for replay as a cache keepalive.
 *
 * max_tokens is set to 1 and stream to false to minimize quota and transport
 * cost. Neither field is part of any prompt-cache tier's identity, so the
 * replay still reads (and thereby TTL-refreshes) every cache entry the
 * original request wrote.
 *
 * We deliberately do NOT use the documented max_tokens: 0 pre-warm shape:
 * that shape rejects bodies carrying stream, enabled thinking, forced
 * tool_choice, or output_config.format, and stripping those fields changes
 * the messages-tier cache identity (thinking and tool_choice are part of
 * it). A stripped warmup would refresh only the tools+system tiers and let
 * the far larger conversation tier expire, silently defeating the feature.
 *
 * Parsing errors are handled gracefully: if the body is not valid JSON the
 * original bytes are replayed unpatched.
 */
export function sanitizeKeepaliveBody(
	body: Uint8Array | ArrayBuffer,
): string | ArrayBuffer {
	const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
	try {
		const bodyJson = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof bodyJson === "object" && bodyJson !== null) {
			bodyJson.max_tokens = 1;
			bodyJson.stream = false;
			return JSON.stringify(bodyJson);
		}
	} catch {
		// Body isn't valid JSON - skip patching and use original
	}
	// Fresh copy so the return is a plain ArrayBuffer regardless of the
	// source view's offset or backing buffer type.
	return bytes.slice().buffer;
}

export class CacheKeepaliveScheduler {
	private proxyContext: ProxyContext;
	private config: Config;
	private unregisterInterval: (() => void) | null = null;
	private currentTtlMinutes = 0;
	private boundConfigChangeHandler:
		| ((event: { key: string; newValue: unknown }) => void)
		| null = null;

	constructor(proxyContext: ProxyContext, config: Config) {
		this.proxyContext = proxyContext;
		this.config = config;
	}

	start(): void {
		this.currentTtlMinutes = this.config.getCacheKeepaliveTtlMinutes();
		cacheBodyStore.setEnabled(this.currentTtlMinutes > 0);

		// Adjust dynamically when TTL config changes
		this.boundConfigChangeHandler = ({
			key,
			newValue,
		}: {
			key: string;
			newValue: unknown;
		}) => {
			if (key === "cache_keepalive_ttl_minutes") {
				const newTtl = typeof newValue === "number" ? newValue : 0;
				if (newTtl !== this.currentTtlMinutes) {
					this.currentTtlMinutes = newTtl;
					cacheBodyStore.setEnabled(newTtl > 0);
					this.restart();
				}
			}
		};
		this.config.on("change", this.boundConfigChangeHandler);

		this.startInterval();
	}

	stop(): void {
		this.stopInterval();
		if (this.boundConfigChangeHandler) {
			this.config.off("change", this.boundConfigChangeHandler);
			this.boundConfigChangeHandler = null;
		}
	}

	private stopInterval(): void {
		if (this.unregisterInterval) {
			this.unregisterInterval();
			this.unregisterInterval = null;
		}
	}

	private restart(): void {
		this.stopInterval();
		this.startInterval();
	}

	private startInterval(): void {
		if (this.currentTtlMinutes <= 0) {
			log.info("Cache keepalive disabled (ttl = 0)");
			return;
		}

		// Fire (ttl - 1) minutes before the cache would expire, minimum 60 seconds
		const intervalMs = Math.max(60_000, (this.currentTtlMinutes - 1) * 60_000);
		const intervalSeconds = Math.floor(intervalMs / 1_000);

		log.info(
			`Starting cache keepalive scheduler, interval: ${intervalSeconds}s (ttl: ${this.currentTtlMinutes}min)`,
		);

		this.unregisterInterval = registerHeartbeat({
			id: "cache-keepalive-scheduler",
			callback: () => this.sendKeepalives(),
			seconds: intervalSeconds,
			description: `Cache keepalive scheduler (TTL ${this.currentTtlMinutes}min)`,
		});
	}

	private async sendKeepalives(): Promise<void> {
		// Evict stale cached requests before sending keepalives.
		// This prevents replaying requests that are clearly no longer warm
		// (e.g., from days ago when the underlying prompt cache has long expired).
		cacheBodyStore.evictStaleEntries(this.currentTtlMinutes);

		const accounts = cacheBodyStore.getAllCachedAccounts();

		if (accounts.length === 0) {
			log.debug(
				"No accounts with cached requests in memory, skipping keepalive",
			);
			return;
		}

		log.info(`Sending cache keepalive to ${accounts.length} account(s)`);

		await Promise.allSettled(
			accounts.map((accountId) => this.replayRequest(accountId)),
		);
	}

	private async replayRequest(accountId: string): Promise<void> {
		const cached = cacheBodyStore.getLastCachedRequest(accountId);
		if (!cached) return;

		try {
			// Reconstruct headers from the stored snapshot.
			// Anthropic's prepareHeaders() copies incoming client headers and augments
			// them, so we need to replay them faithfully. Providers that build from
			// scratch (Qwen, Bedrock) simply ignore whatever we send here.
			// Auth and internal proxy headers were stripped at capture time.
			const replayHeaders = new Headers(cached.headers);
			replayHeaders.set("content-type", "application/json");
			// Inject routing headers fresh — these were stripped from the snapshot
			replayHeaders.set("x-better-ccflare-account-id", accountId);
			replayHeaders.set("x-better-ccflare-bypass-session", "true");

			// Tag as keepalive for dual purpose:
			//  1. Visibility: request logger can identify synthetic requests
			//  2. Loop prevention: proxy skips staging to avoid infinite replay cycle
			replayHeaders.set("x-better-ccflare-keepalive", "true");
			const proxyPort = this.proxyContext.runtime.port;
			const protocol =
				process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH
					? "https"
					: "http";
			const endpoint = `${protocol}://localhost:${proxyPort}${cached.path}`;

			log.debug(
				`Replaying cached request for account ${accountId} (${cached.body.length} bytes, recorded ${Math.round((Date.now() - cached.timestamp) / 1000)}s ago)`,
			);

			const bodyToSend = sanitizeKeepaliveBody(cached.body);

			// For HTTPS localhost requests, use an agent that accepts self-signed certificates.
			// This is needed when SSL_KEY_PATH + SSL_CERT_PATH are configured with self-signed certs.
			// The self-loop request goes through the proxy again, so certificate validation would fail.
			const url = new URL(endpoint);
			const isLocalhost =
				url.hostname === "localhost" ||
				url.hostname === "127.0.0.1" ||
				url.hostname === "::1";
			// CodeQL[js/disabling-certificate-validation]: self-signed localhost self-loop only
			const agent =
				protocol === "https" && isLocalhost
					? new https.Agent({ rejectUnauthorized: false })
					: undefined;

			const response = await fetch(endpoint, {
				method: "POST",
				headers: replayHeaders,
				body: bodyToSend,
				// @ts-expect-error Node.js fetch accepts agent option but it's not in standard Fetch API types
				agent,
			});

			// Drain the response so the connection is released
			await response.text().catch(() => {});

			if (response.ok) {
				log.info(
					`Cache keepalive replayed successfully for account ${accountId}`,
				);
			} else {
				log.warn(
					`Cache keepalive replay returned ${response.status} for account ${accountId}`,
				);
			}
		} catch (error) {
			log.error(`Error replaying keepalive for account ${accountId}:`, error);
		}
	}
}
