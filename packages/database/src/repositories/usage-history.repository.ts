import { weeklyScopedWindowKey } from "@better-ccflare/core";
import type { PredictionPoint, UsageSnapshotRow } from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

/** Duck-typed usage window: an object with a numeric `utilization` and a `resets_at` key. */
function isWindow(
	value: unknown,
): value is { utilization: number; resets_at: string | null } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { utilization?: unknown }).utilization === "number" &&
		"resets_at" in (value as object)
	);
}

/** Duck-typed entry of Anthropic's generic `limits[]` array (session/weekly_all/weekly_scoped). */
function isLimitEntry(value: unknown): value is {
	kind?: string;
	percent?: number | null;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string } | null } | null;
} {
	return typeof value === "object" && value !== null && "kind" in value;
}

/**
 * Maps a `limits[]` entry to the internal window_key used everywhere else
 * (dashboard rows, throttle snapshots): session -> five_hour, weekly_all ->
 * seven_day, weekly_scoped -> seven_day_<slug> via weeklyScopedWindowKey.
 * Returns null for limit kinds we don't track as a history window.
 */
function limitWindowKey(limit: {
	kind?: string;
	scope?: { model?: { display_name?: string } | null } | null;
}): string | null {
	if (limit.kind === "session") return "five_hour";
	if (limit.kind === "weekly_all") return "seven_day";
	if (limit.kind === "weekly_scoped") {
		const name = limit.scope?.model?.display_name?.trim();
		return name ? weeklyScopedWindowKey(name) : null;
	}
	return null;
}

interface SnapshotDbRow {
	account_id: string;
	timestamp: number;
	window_key: string;
	utilization: number;
	resets_at: number | null;
}

export interface GetSeriesOptions {
	accountId: string;
	windowKey?: string;
	since?: number;
	until?: number;
}

export class UsageHistoryRepository extends BaseRepository<UsageSnapshotRow> {
	/**
	 * Insert one row per usage window present in `usage`. One row per successful
	 * poll (NO dedup) — the prediction fit and the chart both need a faithful,
	 * near-uniform series; collapsing flat stretches to a single row makes idle
	 * windows fall out of range queries and biases the regression. Volume is
	 * bounded by retention pruning instead. `usage` is the raw UsageData-shaped
	 * record from the provider cache; non-window fields (extra_usage, unknown
	 * keys) are ignored. A malformed `resets_at` is stored as null, never NaN.
	 *
	 * Anthropic's `limits[]` array (session/weekly_all/weekly_scoped) is folded
	 * in under the same window_key convention as the flat windows (five_hour,
	 * seven_day, seven_day_<slug>) so a limits-only payload — e.g. a per-model
	 * Fable cap with five_hour/seven_day both null — still gets recorded.
	 */
	async recordSnapshot(
		accountId: string,
		usage: Record<string, unknown>,
		now: number,
	): Promise<void> {
		// Build one value tuple per window, then insert them all in a SINGLE
		// statement. A multi-row INSERT is atomic (all-or-nothing) on both SQLite
		// and Postgres, so a failure can no longer leave a partial snapshot the
		// way the previous await-in-loop of per-window inserts could.
		const params: unknown[] = [];
		const seenKeys = new Set<string>();
		let count = 0;
		for (const [windowKey, value] of Object.entries(usage)) {
			if (!isWindow(value)) continue;
			let resetsAt: number | null = null;
			if (value.resets_at) {
				const ms = new Date(value.resets_at).getTime();
				resetsAt = Number.isFinite(ms) ? ms : null;
			}
			params.push(accountId, now, windowKey, value.utilization, resetsAt);
			seenKeys.add(windowKey);
			count++;
		}
		const limits = usage.limits;
		if (Array.isArray(limits)) {
			for (const limit of limits) {
				if (!isLimitEntry(limit) || typeof limit.percent !== "number") continue;
				const windowKey = limitWindowKey(limit);
				// Skip a kind we don't map, and skip one already recorded from the
				// flat windows above (no double-count of five_hour/seven_day).
				if (!windowKey || seenKeys.has(windowKey)) continue;
				let resetsAt: number | null = null;
				if (limit.resets_at) {
					const ms = new Date(limit.resets_at).getTime();
					resetsAt = Number.isFinite(ms) ? ms : null;
				}
				params.push(accountId, now, windowKey, limit.percent, resetsAt);
				seenKeys.add(windowKey);
				count++;
			}
		}
		if (count === 0) return;
		const rows = Array.from({ length: count }, () => "(?, ?, ?, ?, ?)").join(
			", ",
		);
		await this.run(
			`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
			 VALUES ${rows}`,
			params,
		);
	}

	async getSeries(opts: GetSeriesOptions): Promise<UsageSnapshotRow[]> {
		const clauses = ["account_id = ?"];
		const params: unknown[] = [opts.accountId];
		if (opts.windowKey) {
			clauses.push("window_key = ?");
			params.push(opts.windowKey);
		}
		if (opts.since != null) {
			clauses.push("timestamp >= ?");
			params.push(opts.since);
		}
		if (opts.until != null) {
			clauses.push("timestamp <= ?");
			params.push(opts.until);
		}
		const rows = await this.query<SnapshotDbRow>(
			`SELECT account_id, timestamp, window_key, utilization, resets_at
			 FROM usage_snapshots
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY timestamp ASC`,
			params,
		);
		return rows.map((r) => ({
			accountId: r.account_id,
			timestamp: Number(r.timestamp),
			windowKey: r.window_key,
			utilization: Number(r.utilization),
			resetsAt: r.resets_at == null ? null : Number(r.resets_at),
		}));
	}

	async deleteOlderThan(cutoffTs: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM usage_snapshots WHERE timestamp < ?`,
			[cutoffTs],
		);
	}
}

/** Convenience: map snapshot rows to prediction/chart points. */
export function toPredictionPoints(
	rows: UsageSnapshotRow[],
): PredictionPoint[] {
	return rows.map((r) => ({
		t: r.timestamp,
		utilization: r.utilization,
		resetsAt: r.resetsAt,
	}));
}
