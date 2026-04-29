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

interface StagedRequestEntry {
	accountId: string;
	body: ArrayBuffer;
	headers: Record<string, string>;
	path: string;
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

const CACHE_CONTROL_HINTS = [
	new TextEncoder().encode("cache_control"),
	new TextEncoder().encode("cache-control"),
];

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;

	const first = needle[0];
	const limit = haystack.length - needle.length;

	for (let index = 0; index <= limit; index++) {
		if (haystack[index] !== first) continue;

		let matched = true;
		for (let offset = 1; offset < needle.length; offset++) {
			if (haystack[index + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}

		if (matched) return true;
	}

	return false;
}

function hasCacheControlHint(body: ArrayBuffer): boolean {
	const bytes = new Uint8Array(body);
	return CACHE_CONTROL_HINTS.some((hint) => containsBytes(bytes, hint));
}

class CacheBodyStore {
	/** requestId → { accountId, entry } while the request is in-flight. */
	private staging = new Map<string, StagedRequestEntry>();

	/** accountId → last request that created a cache entry. */
	private lastCachedRequest = new Map<string, CachedRequestEntry>();

	/** Whether the feature is enabled — skip staging entirely when false. */
	private enabled = false;

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.staging.clear();
			this.lastCachedRequest.clear();
		}
	}

	/**
	 * Called when a request body has been buffered.
	 * Only stages likely prompt-cache-creating /v1/messages bodies.
	 */
	stageRequest(
		requestId: string,
		accountId: string | null,
		body: ArrayBuffer | null,
		headers: Headers,
		path: string,
	): void {
		if (!this.enabled || !accountId || !body || body.byteLength === 0) return;
		if (path !== "/v1/messages" || !hasCacheControlHint(body)) return;

		const sanitizedHeaders: Record<string, string> = {};
		headers.forEach((value, key) => {
			if (!STRIP_HEADERS.has(key.toLowerCase())) {
				sanitizedHeaders[key] = value;
			}
		});

		this.staging.set(requestId, {
			accountId,
			body,
			headers: sanitizedHeaders,
			path,
			timestamp: Date.now(),
		});
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
		this.staging.delete(requestId);

		if (!staged) return;

		if (cacheCreationInputTokens && cacheCreationInputTokens > 0) {
			this.lastCachedRequest.set(staged.accountId, {
				body: Buffer.from(staged.body),
				headers: staged.headers,
				path: staged.path,
				timestamp: staged.timestamp,
			});
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
