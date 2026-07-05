// packages/http-api/src/services/usage-prediction.ts
import type { PredictionPoint, UsagePrediction } from "@better-ccflare/types";

const HOUR_MS = 60 * 60 * 1000;
const MIN_POINTS = 3;
const MIN_SPAN_MS = 5 * 60 * 1000; // below ~5 min the trend is not trustworthy
const RESET_DROP_THRESHOLD = 5; // pp drop that marks a reset/refund (not jitter)
// Real Anthropic polls report the SAME reset instant but the stored epoch-ms
// jitters by ~±1s. Treat a resets_at change as a new-window boundary only when it
// exceeds this tolerance — far above the ~1s jitter, far below the smallest real
// reset shift (5h). Without this, jitter cuts a segment at every pair.
const RESET_JITTER_TOLERANCE_MS = 60_000;
const LIMIT = 100; // utilization is 0–100

const clamp = (v: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, v));

/**
 * Predict a usage window's trajectory from its recent snapshots. Ported from the
 * battle-tested `calculate_prediction` in robsonek/claude-usage-dashboard: ETA is
 * anchored at current usage; a ≥5 pp drop (reset/refund) segments the data; idle
 * (resets_at == null) readings are excluded when a live window is known; a short
 * data span is flagged low-confidence.
 */
export function computeUsagePrediction(
	points: PredictionPoint[],
): UsagePrediction {
	const sorted = [...points].sort((a, b) => a.t - b.t);
	const latest = sorted.length ? sorted[sorted.length - 1] : null;
	const resetsAtMs = latest ? latest.resetsAt : null;

	const base = {
		slopePerHour: 0,
		etaExhaustMs: null as number | null,
		predictedAtReset: null as number | null,
		resetsAtMs,
		willExhaustBeforeReset: false,
		lowConfidence: false,
	};

	// Already at/over the cap (overage). No forward extrapolation needed.
	if (latest && latest.utilization >= LIMIT) {
		return {
			...base,
			etaExhaustMs: latest.t,
			predictedAtReset: LIMIT,
			willExhaustBeforeReset: true,
			state: "exhausted",
		};
	}

	// When a current-period reset is known, idle readings (resets_at == null) are
	// NOT part of the active window — including them flattens the slope ~10×.
	let pts = sorted;
	if (resetsAtMs != null) {
		const active = sorted.filter((p) => p.resetsAt != null);
		if (active.length >= 2) pts = active;
	}

	// Segment to the current window: cut at the last boundary — a resets_at change
	// OR a drop larger than RESET_DROP_THRESHOLD (a reset/refund, not measurement
	// jitter). Regressing across an 86%→7% "gift" would yield a bogus negative slope.
	let segStart = 0;
	for (let i = 1; i < pts.length; i++) {
		const prev = pts[i - 1];
		const cur = pts[i];
		// A resets_at change marks a new window only when it moves by MORE than the
		// jitter tolerance. A null↔value transition is always a boundary; both-null
		// is never one.
		const prevReset = prev.resetsAt ?? null;
		const curReset = cur.resetsAt ?? null;
		let resetChanged: boolean;
		if (prevReset == null && curReset == null) {
			resetChanged = false;
		} else if (prevReset == null || curReset == null) {
			resetChanged = true;
		} else {
			resetChanged = Math.abs(curReset - prevReset) > RESET_JITTER_TOLERANCE_MS;
		}
		const dropped = cur.utilization < prev.utilization - RESET_DROP_THRESHOLD;
		if (resetChanged || dropped) segStart = i;
	}
	const segment = pts.slice(segStart);

	if (segment.length < MIN_POINTS) {
		return { ...base, state: "insufficient_data" };
	}

	const first = segment[0];
	const last = segment[segment.length - 1];
	const currentUsage = last.utilization;
	const lowConfidence = last.t - first.t < MIN_SPAN_MS;

	// Least-squares on centered, hour-scaled time (avoids float64 cancellation at
	// epoch-ms): utilization = a*x + b, x = (t - first.t)/HOUR_MS, a is per-hour.
	const n = segment.length;
	let sumX = 0;
	let sumU = 0;
	let sumXX = 0;
	let sumXU = 0;
	for (const p of segment) {
		const x = (p.t - first.t) / HOUR_MS;
		sumX += x;
		sumU += p.utilization;
		sumXX += x * x;
		sumXU += x * p.utilization;
	}
	const denom = n * sumXX - sumX * sumX;
	const a = denom === 0 ? 0 : (n * sumXU - sumX * sumU) / denom; // per hour
	const slopePerHour = a;

	// "Target line": projected utilization at the reset moment, anchored at current
	// usage. willExhaustBeforeReset is the raw (unclamped) projection crossing 100.
	const hoursToReset =
		resetsAtMs != null ? Math.max(0, (resetsAtMs - last.t) / HOUR_MS) : null;
	const rawAtReset =
		hoursToReset != null ? currentUsage + a * hoursToReset : null;
	const predictedAtReset =
		!lowConfidence && rawAtReset != null ? clamp(rawAtReset, 0, LIMIT) : null;
	const willExhaustBeforeReset =
		!lowConfidence && rawAtReset != null && rawAtReset >= LIMIT;

	if (a <= 0) {
		return {
			...base,
			slopePerHour,
			predictedAtReset,
			willExhaustBeforeReset,
			lowConfidence,
			state: "stable",
		};
	}

	// ETA to 100% anchored at CURRENT usage (not the fitted intercept) — matches
	// the real latest reading and never lands in the past for a rising trend.
	const etaExhaustMs = lowConfidence
		? null
		: Math.round(last.t + ((LIMIT - currentUsage) / a) * HOUR_MS);

	return {
		...base,
		slopePerHour,
		etaExhaustMs,
		predictedAtReset,
		willExhaustBeforeReset,
		lowConfidence,
		state: "rising",
	};
}
