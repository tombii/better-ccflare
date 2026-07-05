// packages/dashboard-web/src/components/usage-history/chart-data.ts
import type { UsageHistoryWindowSeries } from "@better-ccflare/types";

export interface ChartRow {
	t: number;
	[key: string]: number | string | null;
}

const PRED_SUFFIX = "__pred";
const HOUR_MS = 3_600_000;

const clampPct = (v: number): number => Math.max(0, Math.min(100, v));

/**
 * Merge per-window actual points AND a 2-point dashed prediction segment for
 * each rising window into a single time-indexed recharts dataset. The forecast
 * segment runs from the last actual point to whichever comes first — the ETA,
 * this window's OWN reset, or the NEAREST reset across all windows — so neither
 * a barely-positive slope (Fable M2) nor a far-horizon window (e.g. seven_day
 * resetting ~13h out while five_hour resets in minutes) can stretch the x-domain
 * and squish near-term detail. The endpoint value interpolates the straight-line
 * forecast at that (possibly capped) time. Missing values are `null` (gaps).
 */
export function buildUsageChartData(
	windows: UsageHistoryWindowSeries[],
	now: number,
	horizonMs: number,
): {
	rows: ChartRow[];
	windowKeys: string[];
	predictionKeys: string[];
	markers: { x: number; label: string }[];
} {
	const windowKeys = windows.map((w) => w.window);
	const predictionKeys: string[] = [];
	const byTime = new Map<number, ChartRow>();
	const ensureRow = (t: number): ChartRow => {
		let row = byTime.get(t);
		if (!row) {
			row = { t };
			byTime.set(t, row);
		}
		return row;
	};

	// The single nearest reset > now across all windows (within the horizon). A
	// far-horizon window's forecast is capped here so it can't stretch the domain.
	const markers = resetMarkers(windows, now, horizonMs);
	const nearestResetX = markers[0]?.x ?? null;

	for (const w of windows) {
		for (const p of w.points) ensureRow(p.t)[w.window] = p.utilization;

		const { state, etaExhaustMs, resetsAtMs, slopePerHour } = w.prediction;
		if (state === "rising" && etaExhaustMs != null && w.points.length > 0) {
			const predKey = `${w.window}${PRED_SUFFIX}`;
			const last = w.points[w.points.length - 1];
			ensureRow(last.t)[predKey] = last.utilization;
			// Endpoint time = earliest of ETA, this window's own reset, and the
			// nearest reset across ALL windows. etaExhaustMs is non-null here, so
			// there is always at least one candidate.
			const endpointTime = Math.min(
				...[etaExhaustMs, resetsAtMs, nearestResetX].filter(
					(v): v is number => v != null,
				),
			);
			// Interpolate the straight-line forecast at the (possibly capped)
			// endpoint; an ETA endpoint yields ~100, matching the prior behaviour.
			const endpointValue = clampPct(
				last.utilization + slopePerHour * ((endpointTime - last.t) / HOUR_MS),
			);
			ensureRow(endpointTime)[predKey] = endpointValue;
			predictionKeys.push(predKey);
		}
	}

	const allKeys = [...windowKeys, ...predictionKeys];
	const rows = [...byTime.values()].sort((a, b) => a.t - b.t);
	for (const row of rows) {
		for (const k of allKeys) if (!(k in row)) row[k] = null;
	}

	return {
		rows,
		windowKeys,
		predictionKeys,
		markers,
	};
}

/**
 * A single vertical marker at the nearest upcoming reset within the forward
 * horizon — the smallest `resetsAt` with `now < resetsAt <= now + horizonMs`
 * across all windows' points. Returns `[]` when no reset falls in that window.
 * The upper bound keeps a far-future reset (e.g. a seven_day reset days out)
 * from stretching the x-domain past the selected range. Picking the minimum
 * future value sidesteps the sub-second resets_at jitter that defeated
 * exact-value dedup and cluttered the chart with a line per window reset.
 */
export function resetMarkers(
	windows: UsageHistoryWindowSeries[],
	now: number,
	horizonMs: number,
): { x: number; label: string }[] {
	const limit = now + horizonMs;
	let next: number | null = null;
	for (const w of windows) {
		for (const p of w.points) {
			if (p.resetsAt != null && p.resetsAt > now && p.resetsAt <= limit) {
				if (next == null || p.resetsAt < next) next = p.resetsAt;
			}
		}
	}
	return next == null ? [] : [{ x: next, label: "reset" }];
}

/** Human-readable one-liner about a window's prediction. `now` is injected for determinism. */
export function formatPredictionAnnotation(
	series: UsageHistoryWindowSeries,
	now: number,
): string {
	const { window, prediction } = series;
	const atReset =
		prediction.predictedAtReset != null
			? ` (~${Math.round(prediction.predictedAtReset)}% at reset)`
			: "";
	// Handle terminal/stable states BEFORE lowConfidence — a stable window with a
	// short span is "stable", not "rising" (Fable M6).
	if (prediction.state === "insufficient_data")
		return `${window}: collecting data…`;
	if (prediction.state === "exhausted") return `${window}: at limit (100%+) ⛔`;
	if (prediction.state === "stable") {
		return `${window}: stable — no exhaustion predicted${atReset}`;
	}
	// Only "rising" remains.
	if (prediction.lowConfidence) {
		return `${window}: rising — low confidence (need >5 min of data)`;
	}
	if (prediction.etaExhaustMs == null) return `${window}: rising${atReset}`;
	const hours = Math.max(0, (prediction.etaExhaustMs - now) / (60 * 60 * 1000));
	const eta = hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`;
	if (prediction.willExhaustBeforeReset) {
		return `${window}: ~${eta} to limit ⚠${atReset}`;
	}
	// Don't claim "safe until reset" when there is no known reset window (Fable M6).
	return prediction.resetsAtMs == null
		? `${window}: rising${atReset}`
		: `${window}: rising, safe until reset${atReset}`;
}
