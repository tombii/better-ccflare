import { Logger } from "@better-ccflare/logger";

const log = new Logger("CacheBodyStore");

/**
 * In-memory store for the last request body per account that created a cache entry.
 *
 * Flow:
 *  1. When a request body is buffered in the proxy, stageRequest() is called.
 *  2. When the post-processor emits a summary, onSummary() is called.
 *     - If cacheCreationInputTokens > 0, the staged entry is promoted to the
 *       per-account "last cached request" slot.
 *     - The staging entry is always deleted (request is complete).
 *  3. The keepalive scheduler reads getLastCachedRequest() at tick time and
 *     replays the body through the proxy.
 *
 * Memory bounds:
 *  - stagingMap: one entry per in-flight request, cleared on completion → bounded
 *    by concurrent request count.
 *  - lastCachedRequest: one entry per account → bounded by account count.
 *
 * Note: client headers ARE stored because some providers (e.g. Anthropic) copy
 * incoming headers in prepareHeaders() and augment them, so the replay needs to
 * carry the original client headers to produce an identical upstream request.
 * Providers that build headers from scratch (Qwen, Bedrock) simply ignore them.
 *
 * Sensitive and internal headers are stripped before storing.
 */

/**
 * Only cache requests to this path — other endpoints don't use prompt cache.
 */
const CACHEABLE_PATH = "/v1/messages";

/** Maximum number of in-flight staging entries. Oldest is evicted when exceeded. */
const MAX_STAGING_ENTRIES = 200;

/** Maximum total body bytes held in the staging map. Oldest is evicted when exceeded. */
const MAX_STAGING_BYTES = 64 * 1024 * 1024;

/** Maximum age for a staging entry before it is swept out. */
const STAGING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Byte patterns to search for in the request body to detect cache_control hints.
 * Both quoted forms cover JSON key serialization styles.
 */
const CACHE_CONTROL_HINTS: Uint8Array[] = [
	new TextEncoder().encode('"cache_control"'),
	new TextEncoder().encode('"cache-control"'),
];

function hasCacheControlHint(body: ArrayBuffer): boolean {
	const bytes = Buffer.from(body);
	return CACHE_CONTROL_HINTS.some((hint) => bytes.indexOf(hint) !== -1);
}

export interface CachedRequestEntry {
	/** Original client request body, as-received (pre-transform). */
	body: Buffer;
	/** Sanitized original client headers (no auth, no internal proxy headers). */
	headers: Record<string, string>;
	/** Request path, e.g. "/v1/messages". */
	path: string;
	/** Unix timestamp when this entry was recorded. */
	timestamp: number;
}

// Strip sensitive and internal headers before storing.
// Auth headers are injected by prepareHeaders() from account credentials.
// Internal x-better-ccflare-* headers are injected fresh by the scheduler.
const STRIP_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"cookie",
	"x-better-ccflare-account-id",
	"x-better-ccflare-bypass-session",
	"x-better-ccflare-skip-cache",
	"x-better-ccflare-keepalive",
	"x-better-ccflare-internal-probe-secret",
	"content-length",
	"transfer-encoding",
	"accept-encoding",
	"content-encoding",
	"connection",
	"keep-alive",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"host",
]);

class CacheBodyStore {
	/** requestId → { accountId, entry } while the request is in-flight. */
	private staging = new Map<
		string,
		{ accountId: string; entry: CachedRequestEntry }
	>();

	/** Sum of body byte lengths currently in `staging`. */
	private stagingBytes = 0;

	/** accountId → last request that created a cache entry. */
	private lastCachedRequest = new Map<string, CachedRequestEntry>();

	/** Whether the feature is enabled — skip staging entirely when false. */
	private enabled = false;

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.staging.clear();
			this.stagingBytes = 0;
			this.lastCachedRequest.clear();
		}
	}

	/**
	 * Called when a request body has been buffered.
	 * Only stages if the feature is enabled and we have a body.
	 */
	stageRequest(
		requestId: string,
		accountId: string | null,
		body: ArrayBuffer | null,
		headers: Headers,
		path: string,
	): void {
		if (!this.enabled || !accountId || !body || body.byteLength === 0) return;

		// Only cache prompt-cache-relevant endpoint.
		if (path !== CACHEABLE_PATH) return;

		// Only stage if the body contains a cache_control hint — requests without
		// prompt-cache markers won't create cache entries, nothing to keep alive.
		if (!hasCacheControlHint(body)) return;

		const sanitizedHeaders: Record<string, string> = {};
		headers.forEach((value, key) => {
			if (!STRIP_HEADERS.has(key.toLowerCase())) {
				sanitizedHeaders[key] = value;
			}
		});

		this.deleteStaged(requestId);
		this.stagingBytes += body.byteLength;
		this.staging.set(requestId, {
			accountId,
			entry: {
				body: Buffer.from(body),
				headers: sanitizedHeaders,
				path,
				timestamp: Date.now(),
			},
		});

		// Enforce entry-count and byte caps: evict oldest (Map insertion order).
		while (
			this.staging.size > MAX_STAGING_ENTRIES ||
			this.stagingBytes > MAX_STAGING_BYTES
		) {
			const oldestId = this.staging.keys().next().value;
			if (oldestId === undefined) break;
			this.deleteStaged(oldestId);
			log.warn(
				`Staging cap (${MAX_STAGING_ENTRIES} entries / ${MAX_STAGING_BYTES} bytes) exceeded — evicted oldest entry (requestId=${oldestId})`,
			);
		}

		// Sweep stale entries on every stage call.
		this.sweepStagingByAge();
	}

	/**
	 * Discards a staged entry without promoting it. Call on terminal error paths
	 * (e.g. all-accounts-failed throw) where onSummary will never fire, to prevent
	 * the staging map from leaking memory.
	 */
	discardStaged(requestId: string): void {
		this.deleteStaged(requestId);
	}

	private deleteStaged(requestId: string): void {
		const staged = this.staging.get(requestId);
		if (!staged) return;
		this.stagingBytes -= staged.entry.body.byteLength;
		this.staging.delete(requestId);
	}

	/**
	 * Removes staging entries that are older than STAGING_MAX_AGE_MS.
	 * Handles the worker-restart orphan case where onSummary never fires.
	 */
	sweepStagingByAge(): void {
		const cutoff = Date.now() - STAGING_MAX_AGE_MS;
		let swept = 0;
		for (const [id, staged] of this.staging) {
			if (staged.entry.timestamp < cutoff) {
				this.deleteStaged(id);
				swept++;
			}
		}
		if (swept > 0) {
			log.info(
				`Swept ${swept} orphaned staging entr${swept === 1 ? "y" : "ies"} older than ${STAGING_MAX_AGE_MS / 1000}s`,
			);
		}
	}

	/**
	 * Called when the post-processor emits a summary for a completed request.
	 * Promotes to per-account slot if caching was used; always cleans up staging.
	 */
	onSummary(
		requestId: string,
		cacheCreationInputTokens: number | undefined,
	): void {
		const staged = this.staging.get(requestId);
		this.deleteStaged(requestId);

		if (!staged) return;

		if (cacheCreationInputTokens && cacheCreationInputTokens > 0) {
			this.lastCachedRequest.set(staged.accountId, staged.entry);
		}
	}

	/**
	 * Returns the last request body that created a cache entry for this account,
	 * or null if none is recorded.
	 */
	getLastCachedRequest(accountId: string): CachedRequestEntry | null {
		return this.lastCachedRequest.get(accountId) ?? null;
	}

	/** Returns all accounts that have a recorded cached request. */
	getAllCachedAccounts(): string[] {
		return Array.from(this.lastCachedRequest.keys());
	}

	/** Remove a specific account's cached entry (e.g. account deleted). */
	evict(accountId: string): void {
		this.lastCachedRequest.delete(accountId);
	}

	/**
	 * Evicts cached request entries older than the specified age threshold.
	 * Called at keepalive tick time to prevent replaying stale requests whose
	 * underlying prompt cache has long expired.
	 *
	 * @param ttlMinutes The configured cache TTL in minutes
	 * @param ageMultiplier Multiplier for TTL to determine max age (default: 3)
	 *                      e.g. TTL 5min with multiplier 3 = evict entries older than 15min
	 */
	evictStaleEntries(ttlMinutes: number, ageMultiplier = 3): void {
		const maxAgeMs = ttlMinutes * 60_000 * ageMultiplier;
		const cutoffTime = Date.now() - maxAgeMs;
		let evictedCount = 0;

		for (const [accountId, entry] of this.lastCachedRequest.entries()) {
			if (entry.timestamp < cutoffTime) {
				this.lastCachedRequest.delete(accountId);
				evictedCount++;
			}
		}

		if (evictedCount > 0) {
			const maxAgeMinutes = Math.round(maxAgeMs / 60_000);
			log.info(
				`Evicted ${evictedCount} stale cached request(s) older than ${maxAgeMinutes}min (TTL: ${ttlMinutes}min × ${ageMultiplier})`,
			);
		}
	}
}

export const cacheBodyStore = new CacheBodyStore();
