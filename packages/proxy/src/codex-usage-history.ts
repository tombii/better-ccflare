import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("CodexUsageHistory");

/**
 * Codex reports usage only through response headers — its provider config sets
 * `supportsUsageTracking: false`, so nothing polls it and no usage row is ever
 * written by the pollers that serve Anthropic. That left the weekly percentage
 * with no durable home: the in-memory cache expires in 10 minutes and dies with
 * the process, `accounts.rate_limit_reset` keeps only the soonest reset (never a
 * percentage), and the request_payloads copy is incidental and pruned after
 * DATA_RETENTION_DAYS (default 1 day) — for a window that is 7 days long.
 *
 * Writing the same `usage_snapshots` rows Anthropic writes fixes that with no
 * schema change: retention, pruning, the /api/usage-history endpoint and the
 * chart all already handle this table.
 */

/**
 * Traffic-driven writes need their own throttle. `recordSnapshot` deliberately
 * does NOT dedup — the chart and the prediction fit both want a faithful,
 * near-uniform series — so on a busy proxy an unthrottled call would insert a
 * row per request. 90s matches the Anthropic polling cadence (`startPolling`'s
 * default interval in usage-fetcher.ts), which is the shape the series and the
 * regression are tuned for.
 */
const MIN_INTERVAL_MS = 90_000;

/**
 * Last write per account. Bounded by the number of Codex accounts; an entry for
 * a deleted account is a single number and is overwritten if the id ever comes
 * back, so no cleanup hook is needed.
 */
const lastWrittenAt = new Map<string, number>();

/** Exposed for tests: forget the throttle state. */
export function resetCodexUsageHistoryThrottle(): void {
	lastWrittenAt.clear();
}

/**
 * Keep only windows that carry both a real percentage and a real reset.
 * `parseCodexUsageHeaders` fills a window missing from the headers with
 * `{ utilization: defaultUtilization, resets_at: null }`, so a `resets_at` of
 * null is the tell for a synthetic window. Recording those would poison the
 * history with zeros that read as "nothing was used this week".
 */
function realWindows(usage: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(usage)) {
		if (typeof value !== "object" || value === null) continue;
		const window = value as { utilization?: unknown; resets_at?: unknown };
		if (typeof window.utilization !== "number") continue;
		if (typeof window.resets_at !== "string" || window.resets_at === "")
			continue;
		out[key] = value;
	}
	return out;
}

/**
 * Persist a Codex usage payload into `usage_snapshots`.
 *
 * @param force - skip the throttle. Used by the manual refresh endpoint, where
 * the operator explicitly asked for a fresh read and expects it to be kept.
 * @returns true when rows were written.
 */
export async function recordCodexUsageSnapshot(
	dbOps: DatabaseOperations,
	accountId: string,
	accountName: string,
	usage: Record<string, unknown>,
	now: number,
	force = false,
): Promise<boolean> {
	const windows = realWindows(usage);
	if (Object.keys(windows).length === 0) return false;

	if (!force) {
		const last = lastWrittenAt.get(accountId);
		if (last != null && now - last < MIN_INTERVAL_MS) return false;
	}
	// Claim the slot before awaiting so concurrent responses for the same account
	// cannot both pass the check and double-write.
	lastWrittenAt.set(accountId, now);

	try {
		await dbOps.recordUsageSnapshot(accountId, windows, now);
		return true;
	} catch (error) {
		// Usage history is observability, never on the request path's critical
		// line: log and move on.
		log.warn(
			`Failed to record Codex usage snapshot for ${accountName}: ${error}`,
		);
		return false;
	}
}
