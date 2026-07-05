// packages/types/src/usage-history.ts

/** One persisted usage-window measurement. `utilization` is 0–100. */
export interface UsageSnapshotRow {
	accountId: string;
	timestamp: number; // ms epoch — when the snapshot was taken
	windowKey: string; // e.g. "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet"
	utilization: number; // 0–100
	resetsAt: number | null; // ms epoch when the window resets
}

/** A single point fed to the prediction fn / chart. */
export interface PredictionPoint {
	t: number; // ms epoch
	utilization: number; // 0–100
	resetsAt: number | null;
}

export interface UsagePrediction {
	slopePerHour: number; // fitted utilization gain per hour over the current segment (0 only when the fit is flat or has too few points)
	etaExhaustMs: number | null; // ms epoch reaching 100%, anchored at CURRENT usage; null unless rising/exhausted
	predictedAtReset: number | null; // clamped projected utilization (0–100) at the window reset ("target line"); null if no reset/low-confidence
	resetsAtMs: number | null; // current window reset (ms epoch)
	willExhaustBeforeReset: boolean; // the RAW (unclamped) projected-at-reset value >= 100
	state: "insufficient_data" | "stable" | "rising" | "exhausted";
	lowConfidence: boolean; // data span < ~5 min — trend not trustworthy; etaExhaustMs/predictedAtReset suppressed (slopePerHour still reported)
}

export interface UsageHistoryWindowSeries {
	window: string;
	points: PredictionPoint[];
	prediction: UsagePrediction;
}

export interface UsageHistoryResponse {
	accountId: string;
	range: string;
	windows: UsageHistoryWindowSeries[];
}
