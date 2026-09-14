/**
 * Benching an account before it runs its usage window down to zero.
 *
 * The proxy already reacts to exhaustion after the fact: a 429 arrives, the
 * account earns a cooldown, and traffic fails over. That is the right
 * behaviour for a shared pool, but it is the wrong behaviour for an account
 * someone wants to keep something in reserve on — by the time the 429 lands,
 * the window is already spent.
 *
 * The usage poller knows each account's 5-hour and weekly utilization long
 * before that point. This module turns those readings into a decision: pause
 * the account at the percentage its owner nominated, and let it back in once
 * the window has rolled over. Both thresholds are per account and optional;
 * an account with neither set behaves exactly as it did before.
 *
 * Pure by design — the caller owns the database write and the logging, so the
 * rules stay testable without a database or a poller.
 */

/** A usage window that can carry a pause threshold. */
export type UsagePauseWindow = "five_hour" | "weekly";

/**
 * The reason written to `accounts.pause_reason` for a threshold pause.
 *
 * `rate_limit_window` was reserved by the load balancer for exactly this case
 * and is already on its auto-unpause allowlist, so a threshold-paused account
 * is also picked back up by the existing window-reset paths rather than being
 * stranded if the poller stops.
 */
export const USAGE_THRESHOLD_PAUSE_REASON = "rate_limit_window";

/** Per-account pause thresholds, as whole percentages. `null` disables one. */
export interface UsagePauseThresholds {
	fiveHour: number | null;
	weekly: number | null;
}

/**
 * Utilization for the two windows as of the latest poll, 0–100. `null` means
 * the usage API did not report that window on this snapshot — distinct from 0,
 * which is a genuine reading of a freshly reset window.
 */
export interface UsageUtilization {
	fiveHour: number | null;
	weekly: number | null;
}

/** What the caller should do with the account, given the latest snapshot. */
export type UsagePauseDecision =
	| {
			action: "pause";
			window: UsagePauseWindow;
			utilization: number;
			threshold: number;
	  }
	| { action: "resume" }
	| { action: "none" };

/** Everything the decision depends on: the settings, the reading, the state. */
export interface UsagePauseInput {
	thresholds: UsagePauseThresholds;
	utilization: UsageUtilization;
	paused: boolean;
	pauseReason: string | null;
}

/** The windows in the order they are reported when both are over. */
const WINDOWS: ReadonlyArray<{
	window: UsagePauseWindow;
	key: keyof UsagePauseThresholds;
}> = [
	{ window: "five_hour", key: "fiveHour" },
	{ window: "weekly", key: "weekly" },
];

/**
 * Decide whether a usage snapshot should pause or resume an account.
 *
 * Pauses when a configured window has reached its threshold and the account is
 * running. Resumes only an account this rule paused, and only once every
 * configured window reads back below its threshold — a window the snapshot did
 * not report is treated as "still unknown", never as "recovered", so a partial
 * payload cannot hand an exhausted account back to traffic. Manual, overage and
 * failure pauses are left entirely alone.
 */
export function evaluateUsagePause(input: UsagePauseInput): UsagePauseDecision {
	const { thresholds, utilization, paused, pauseReason } = input;

	const configured = WINDOWS.map(({ window, key }) => ({
		window,
		threshold: thresholds[key],
		utilization: utilization[key],
	})).filter(
		(entry): entry is typeof entry & { threshold: number } =>
			entry.threshold !== null,
	);

	if (paused) {
		// Only this rule's own pauses are ours to lift.
		if (pauseReason !== USAGE_THRESHOLD_PAUSE_REASON) return { action: "none" };

		const everyWindowRecovered = configured.every(
			(entry) =>
				entry.utilization !== null && entry.utilization < entry.threshold,
		);
		return everyWindowRecovered ? { action: "resume" } : { action: "none" };
	}

	for (const entry of configured) {
		if (entry.utilization !== null && entry.utilization >= entry.threshold) {
			return {
				action: "pause",
				window: entry.window,
				utilization: entry.utilization,
				threshold: entry.threshold,
			};
		}
	}

	return { action: "none" };
}

/**
 * Read the 5-hour and weekly utilization out of a usage payload.
 *
 * Anthropic is moving the flat `five_hour` / `seven_day` fields into a generic
 * `limits[]` array, and a payload can carry either shape (or both, mid
 * migration). The flat fields win when present; `limits[]` fills in whatever
 * they leave out, mapping `kind: "session"` to the 5-hour window and
 * `kind: "weekly_all"` to the weekly one. Per-model weekly caps
 * (`kind: "weekly_scoped"`) are deliberately ignored — a threshold on "the
 * weekly window" means the all-models window, not the Opus sub-cap.
 *
 * Anything missing or non-numeric reads back as `null`, which
 * {@link evaluateUsagePause} treats as "unknown", never as "recovered".
 */
export function readUsageUtilization(payload: unknown): UsageUtilization {
	if (typeof payload !== "object" || payload === null) {
		return { fiveHour: null, weekly: null };
	}
	const data = payload as Record<string, unknown>;

	const flat = (key: string): number | null => {
		const window = data[key];
		if (typeof window !== "object" || window === null) return null;
		const value = (window as { utilization?: unknown }).utilization;
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	};

	const fromLimits = (kind: string): number | null => {
		const limits = data.limits;
		if (!Array.isArray(limits)) return null;
		for (const entry of limits) {
			if (typeof entry !== "object" || entry === null) continue;
			const limit = entry as { kind?: unknown; percent?: unknown };
			if (limit.kind !== kind) continue;
			return typeof limit.percent === "number" && Number.isFinite(limit.percent)
				? limit.percent
				: null;
		}
		return null;
	};

	return {
		fiveHour: flat("five_hour") ?? fromLimits("session"),
		weekly: flat("seven_day") ?? fromLimits("weekly_all"),
	};
}

/**
 * Normalize a threshold coming from an API body, a CLI argument or a form
 * field into a whole percentage between 1 and 100, or `null` for "unset".
 *
 * Throws on anything else rather than silently clamping: a typo that turns
 * into a 100 would quietly disable the very protection the caller asked for,
 * and one that turns into a 1 would bench the account immediately.
 */
export function parseUsagePauseThreshold(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;

	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isInteger(parsed)) {
		throw new Error(
			"Usage pause threshold must be a whole number between 1 and 100",
		);
	}
	if (parsed < 1 || parsed > 100) {
		throw new Error(
			"Usage pause threshold must be a whole number between 1 and 100",
		);
	}
	return parsed;
}
