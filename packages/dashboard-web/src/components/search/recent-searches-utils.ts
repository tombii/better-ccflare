import type {
	WebToolCallStatus,
	WebToolCallSummary,
} from "../../lib/search-provider-types";

/**
 * Pure helpers behind the "Recent searches" section. Kept out of the
 * components so the rules can be tested without a DOM.
 */

/** The summary strip's numbers for the whole window. */
export interface RecentSearchTotals {
	served: number;
	errors: number;
	fellThrough: number;
	avgLatencyMs: number;
	totalResults: number;
	calls: number;
}

/**
 * Fold the per-(provider, status) summary buckets into one total per status.
 * The average latency is weighted by call count, so a quiet provider does not
 * pull it towards zero.
 */
export function summarizeTraces(
	buckets: WebToolCallSummary[],
): RecentSearchTotals {
	let served = 0;
	let errors = 0;
	let fellThrough = 0;
	let totalLatencyMs = 0;
	let totalResults = 0;

	for (const bucket of buckets) {
		const count = Number.isFinite(bucket.callCount)
			? Math.max(0, bucket.callCount)
			: 0;
		if (bucket.status === "ok") served += count;
		else if (bucket.status === "error") errors += count;
		else fellThrough += count;
		totalLatencyMs += Number.isFinite(bucket.totalLatencyMs)
			? bucket.totalLatencyMs
			: 0;
		totalResults += Number.isFinite(bucket.totalResults)
			? bucket.totalResults
			: 0;
	}

	const calls = served + errors + fellThrough;
	return {
		served,
		errors,
		fellThrough,
		calls,
		avgLatencyMs: calls > 0 ? Math.round(totalLatencyMs / calls) : 0,
		totalResults,
	};
}

/** Characters kept in the table's query cell before the ellipsis. */
export const QUERY_PREVIEW_CHARS = 80;

/** Truncate a query for the table; the full text goes in the title tooltip. */
export function truncateQuery(
	query: string | null,
	maxChars = QUERY_PREVIEW_CHARS,
): string {
	if (query === null || query === "") return "—";
	return query.length > maxChars ? `${query.slice(0, maxChars)}…` : query;
}

export const STATUS_LABELS: Record<WebToolCallStatus, string> = {
	ok: "served",
	error: "error",
	fallthrough: "fell through",
};

/**
 * Badge classes per status: ok is green, error red, fallthrough amber. The
 * explicit dark variants keep the amber readable on a dark background.
 */
export const STATUS_BADGE_CLASSES: Record<WebToolCallStatus, string> = {
	ok: "border-transparent bg-green-500 text-white",
	error: "border-transparent bg-destructive text-destructive-foreground",
	fallthrough:
		"border-amber-500/50 bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
};

/** Relative time for "12s ago", "5m ago", "3h ago", "2d ago". */
export function formatRelativeTime(timestamp: number, now: number): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Latency cell: whole milliseconds, or an em dash when unknown. */
export function formatLatency(ms: number): string {
	return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms)}ms` : "—";
}
