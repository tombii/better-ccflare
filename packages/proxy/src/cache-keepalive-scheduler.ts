import type { Config } from "@better-ccflare/config";
import { registerHeartbeat } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { cacheBodyStore } from "./cache-body-store";
import type { ProxyContext } from "./proxy";

const log = new Logger("CacheKeepaliveScheduler");

export class CacheKeepaliveScheduler {
	private proxyContext: ProxyContext;
	private config: Config;
	private unregisterInterval: (() => void) | null = null;
	private currentTtlMinutes = 0;

	constructor(proxyContext: ProxyContext, config: Config) {
		this.proxyContext = proxyContext;
		this.config = config;
	}

	start(): void {
		this.currentTtlMinutes = this.config.getCacheKeepaliveTtlMinutes();
		cacheBodyStore.setEnabled(this.currentTtlMinutes > 0);

		// Adjust dynamically when TTL config changes
		this.config.on(
			"change",
			({ key, newValue }: { key: string; newValue: unknown }) => {
				if (key === "cache_keepalive_ttl_minutes") {
					const newTtl = typeof newValue === "number" ? newValue : 0;
					if (newTtl !== this.currentTtlMinutes) {
						this.currentTtlMinutes = newTtl;
						cacheBodyStore.setEnabled(newTtl > 0);
						this.restart();
					}
				}
			},
		);

		this.startInterval();
	}

	stop(): void {
		if (this.unregisterInterval) {
			this.unregisterInterval();
			this.unregisterInterval = null;
		}
	}

	private restart(): void {
		this.stop();
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
		const accounts = cacheBodyStore.getAllCachedAccounts();

		if (accounts.length === 0) {
			log.debug(
				"No accounts with cached requests in memory, skipping keepalive",
			);
			return;
		}

		log.info(`Sending cache keepalive to ${accounts.length} account(s)`);

		for (const accountId of accounts) {
			await this.replayRequest(accountId);
		}
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

			const proxyPort = this.proxyContext.runtime.port;
			const protocol =
				process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH
					? "https"
					: "http";
			const endpoint = `${protocol}://localhost:${proxyPort}${cached.path}`;

			log.debug(
				`Replaying cached request for account ${accountId} (${cached.body.length} bytes, recorded ${Math.round((Date.now() - cached.timestamp) / 1000)}s ago)`,
			);

			const response = await fetch(endpoint, {
				method: "POST",
				headers: replayHeaders,
				body: new Uint8Array(cached.body),
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
