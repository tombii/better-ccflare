import { AUTO_REFRESH_MAX_JITTER_MS } from "./constants";

/**
 * Compute a bounded randomized delay before an auto-refresh action.
 * Combines a stable per-account offset with random jitter so accounts spread out
 * without locking into sync over time (mirrors usage-fetcher poll jitter).
 */
export function computeRefreshScheduleDelay(
	accountId: string,
	maxJitterMs = AUTO_REFRESH_MAX_JITTER_MS,
): number {
	if (maxJitterMs <= 0) {
		return 0;
	}

	let hash = 0;
	for (let i = 0; i < accountId.length; i++) {
		hash = (hash * 31 + accountId.charCodeAt(i)) >>> 0;
	}

	const half = maxJitterMs / 2;
	const stableComponent = hash % Math.max(1, Math.floor(half));
	const randomComponent = Math.random() * half;
	return Math.floor(stableComponent + randomComponent);
}

export function sleepMs(ms: number): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run independent account work after per-item delays concurrently.
 * Total wall time is bounded by the largest delay + slowest task, not the sum
 * of every delay. This keeps scheduler ticks from stretching into minutes when
 * many accounts are eligible at once.
 */
export async function runStaggered<T>(
	items: readonly T[],
	getDelayMs: (item: T) => number,
	run: (item: T, delayMs: number) => Promise<void> | void,
): Promise<PromiseSettledResult<void>[]> {
	return Promise.allSettled(
		items.map(async (item) => {
			const delayMs = getDelayMs(item);
			await sleepMs(delayMs);
			await run(item, delayMs);
		}),
	);
}
