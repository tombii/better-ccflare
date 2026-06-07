import type { RequestPayload, RequestSummary } from "../api";

export interface RequestsCacheData {
	requests: RequestPayload[];
	detailsMap: Map<string, RequestSummary>;
}

/** Keep unreconciled live SSE rows visible briefly after a persisted reload. */
const PENDING_PERSISTENCE_MAX_AGE_MS = 30 * 60 * 1000;

function toDetailsMap(
	detailsMap: Map<string, RequestSummary> | RequestSummary[],
): Map<string, RequestSummary> {
	if (detailsMap instanceof Map) return detailsMap;
	return new Map(detailsMap.map((summary) => [summary.id, summary]));
}

function shouldPreserveLiveRow(
	row: RequestPayload,
	fetchedIds: Set<string>,
	now: number,
): boolean {
	if (fetchedIds.has(row.id)) return false;

	if (row.meta.pending) {
		return now - row.meta.timestamp <= PENDING_PERSISTENCE_MAX_AGE_MS;
	}

	if (row.meta.pendingPersistence) {
		return now - row.meta.timestamp <= PENDING_PERSISTENCE_MAX_AGE_MS;
	}

	if (row.meta.persistenceFailed) {
		return now - row.meta.timestamp <= PENDING_PERSISTENCE_MAX_AGE_MS;
	}

	return false;
}

/**
 * Merge persisted `/api/requests` data with still-live SSE cache entries so
 * reload does not silently drop rows that have not landed in the DB yet.
 */
export function reconcileRequestsCache(
	fetched: RequestsCacheData,
	previous: RequestsCacheData | undefined,
	limit: number,
	now = Date.now(),
): RequestsCacheData {
	const fetchedMap = toDetailsMap(fetched.detailsMap);
	const fetchedIds = new Set(fetched.requests.map((row) => row.id));

	const preservedLive =
		previous?.requests.filter((row) =>
			shouldPreserveLiveRow(row, fetchedIds, now),
		) ?? [];

	const mergedRequests: RequestPayload[] = [];
	const mergedDetails = new Map<string, RequestSummary>();

	for (const row of [...preservedLive, ...fetched.requests]) {
		if (mergedRequests.some((existing) => existing.id === row.id)) continue;

		const fetchedSummary = fetchedMap.get(row.id);
		const previousSummary = previous
			? toDetailsMap(previous.detailsMap).get(row.id)
			: undefined;

		mergedRequests.push(
			fetchedSummary
				? {
						...row,
						meta: {
							...row.meta,
							pending: false,
							pendingPersistence: undefined,
							persistenceFailed: undefined,
						},
					}
				: row,
		);

		const summary = fetchedSummary ?? previousSummary;
		if (summary) {
			mergedDetails.set(row.id, summary);
		}
	}

	return {
		requests: mergedRequests.slice(0, limit),
		detailsMap: mergedDetails,
	};
}
