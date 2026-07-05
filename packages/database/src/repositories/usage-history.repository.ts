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
	 */
	async recordSnapshot(
		accountId: string,
		usage: Record<string, unknown>,
		now: number,
	): Promise<void> {
		for (const [windowKey, value] of Object.entries(usage)) {
			if (!isWindow(value)) continue;
			const utilization = value.utilization;
			let resetsAt: number | null = null;
			if (value.resets_at) {
				const ms = new Date(value.resets_at).getTime();
				resetsAt = Number.isFinite(ms) ? ms : null;
			}
			await this.run(
				`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[accountId, now, windowKey, utilization, resetsAt],
			);
		}
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
