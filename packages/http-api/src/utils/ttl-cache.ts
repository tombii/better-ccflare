const MAX_ENTRIES = 32;

interface CompletedEntry<T> {
	value: T;
	/** Epoch ms when the entry expires. */
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
 *   In-flight loads live in their own map and are never evicted while running.
 * - Rejected loaders are never cached.
 * - At most 32 completed keys are kept (oldest inserted is evicted first), so
 *   varying query params cannot grow the cache without bound.
 * - `clear()` drops completed and in-flight bookkeeping; a load that was
 *   running during `clear()` does not repopulate the cache.
 */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now) {
	const completed = new Map<string, CompletedEntry<T>>();
	const inFlight = new Map<string, Promise<T>>();
	let generation = 0;

	function get(key: string, loader: () => Promise<T>): Promise<T> {
		const done = completed.get(key);
		if (done) {
			if (done.expiresAt > now()) return Promise.resolve(done.value);
			completed.delete(key);
		}

		const running = inFlight.get(key);
		if (running) return running;

		const startedGeneration = generation;
		const promise = startLoader(loader);
		inFlight.set(key, promise);

		promise.then(
			(value) => {
				// Ignore loads that were cleared away or superseded while running.
				if (startedGeneration !== generation || inFlight.get(key) !== promise)
					return;
				inFlight.delete(key);
				completed.set(key, { value, expiresAt: now() + ttlMs });
				while (completed.size > MAX_ENTRIES) {
					const oldest = completed.keys().next().value;
					if (oldest === undefined) break;
					completed.delete(oldest);
				}
			},
			() => {
				if (inFlight.get(key) === promise) inFlight.delete(key);
			},
		);

		return promise;
	}

	return {
		get,
		clear(): void {
			generation++;
			completed.clear();
			inFlight.clear();
		},
	};
}
