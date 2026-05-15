import type { Config } from "@better-ccflare/config";
import { registerHeartbeat } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { cacheBodyStore } from "./cache-body-store";
import { dispatchProxyRequest } from "./dispatch";
import type { ProxyContext } from "./proxy";

const log = new Logger("CacheKeepaliveScheduler");

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

			log.debug(
				`Replaying cached request for account ${accountId} (${cached.body.length} bytes, recorded ${Math.round((Date.now() - cached.timestamp) / 1000)}s ago)`,
			);

			// Patch max_tokens to 1 to minimize quota consumption.
			// The keepalive only needs to warm the cache, not generate a full completion.
			// Parsing errors are handled gracefully - if body isn't valid JSON, we skip
			// the patching and use the original body as-is.
			let bodyToSend: BodyInit = new Uint8Array(cached.body);
			try {
				const bodyJson = JSON.parse(new TextDecoder().decode(cached.body));
				if (typeof bodyJson === "object" && bodyJson !== null) {
					bodyJson.max_tokens = 1;
					bodyToSend = JSON.stringify(bodyJson);
				}
			} catch {
				// Body isn't valid JSON - skip patching and use original
			}

			// Dispatch in-process through the proxy pipeline. No HTTP self-loop,
			// no TLS, no port. The URL is just for handleProxy's parsing — the
			// real routing is driven by x-better-ccflare-account-id above.
			const url = new URL(`http://internal.better-ccflare${cached.path}`);
			const req = new Request(url, {
				method: "POST",
				headers: replayHeaders,
				body: bodyToSend,
			});
			const response = await dispatchProxyRequest(req, url, this.proxyContext);

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
