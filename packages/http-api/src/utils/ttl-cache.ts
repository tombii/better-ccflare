const MAX_ENTRIES = 32;

interface Entry<T> {
	/** Resolved value, or the in-flight promise while loading. */
	promise: Promise<T>;
	/** Epoch ms when the entry expires; Infinity while still loading. */
	expiresAt: number;
}

/** Invoke the loader synchronously, turning sync throws into rejections. */
function startLoader<T>(loader: () => Promise<T>): Promise<T> {
	try {
		return loader();
	} catch (err) {
		return Promise.reject(err);
	}
}

/**
 * Small keyed TTL cache with in-flight de-duplication.
 *
 * - Values are served from cache until `ttlMs` has elapsed.
 * - Concurrent `get` calls for the same key share a single loader promise.
 * - Rejected loaders are never cached.
 * - At most 32 keys are kept (oldest inserted is evicted first), so varying
 *   query params cannot grow the cache without bound.
 */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now) {
	const entries = new Map<string, Entry<T>>();

	function get(key: string, loader: () => Promise<T>): Promise<T> {
		const existing = entries.get(key);
		if (existing && existing.expiresAt > now()) {
			return existing.promise;
		}
		if (existing) entries.delete(key);

		const entry: Entry<T> = {
			promise: startLoader(loader),
			expiresAt: Number.POSITIVE_INFINITY,
		};
		entries.set(key, entry);

		while (entries.size > MAX_ENTRIES) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}

		entry.promise.then(
			() => {
				// Only stamp the expiry if this entry is still the live one.
				if (entries.get(key) === entry) entry.expiresAt = now() + ttlMs;
			},
			() => {
				if (entries.get(key) === entry) entries.delete(key);
			},
		);

		return entry.promise;
	}

	return {
		get,
		clear(): void {
			entries.clear();
		},
	};
}
