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
 * Deliberately NOT one of the load balancer's auto-unpause reasons. Those
 * paths resume an account as soon as its stored `rate_limit_reset` has
 * elapsed, and that timestamp describes one window — for Codex, whichever
 * window the provider reported. A five-hour reset would then return an
 * account to rotation while the weekly threshold it was benched for is still
 * exceeded, and it would serve traffic until the next poll benched it again.
 *
 * Resuming is therefore owned solely by the usage poller, which is the only
 * place that sees every configured window at once. The cost is that an
 * account stays benched if usage polling stops entirely; unpausing by hand
 * clears it, and polling is what the feature depends on in any case.
 */
export const USAGE_THRESHOLD_PAUSE_REASON = "usage_threshold";

/**
 * One window's setting: the percentage its owner chose, and whether it is
 * currently in force.
 *
 * The two are stored separately so switching a window off keeps the number
 * rather than making someone type it again when they switch it back on. A
 * window with `enabled: false`, or with no percent yet, is simply not
 * considered.
 */
export interface UsagePauseSetting {
	enabled: boolean;
	percent: number | null;
}

/** Per-account pause settings, one per window. */
export interface UsagePauseThresholds {
	fiveHour: UsagePauseSetting;
	weekly: UsagePauseSetting;
}

/** The percentage a window will actually pause at, or null when it will not. */
export function effectiveThreshold(
	setting: UsagePauseSetting | null | undefined,
): number | null {
	if (!setting?.enabled) return null;
	return setting.percent ?? null;
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
		threshold: effectiveThreshold(thresholds[key]),
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
 * Read a nested numeric field (e.g. `payload.tokens_limit.percentage`) off an
 * object, returning `null` when the parent is missing/not an object or the
 * field is missing/non-numeric.
 */
function readNestedNumber(
	data: Record<string, unknown>,
	parentKey: string,
	childKey: string,
): number | null {
	const parent = data[parentKey];
	if (typeof parent !== "object" || parent === null) return null;
	const value = (parent as Record<string, unknown>)[childKey];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * zai payload shape: `{ tokens_limit: {percentage}|null, tokens_limit_weekly:
 * {percentage}|null, time_limit: ... }`. `time_limit` caps the web tools, not
 * model traffic, so it is never read into either window — mirrors the
 * exclusion `tokenWindows()` in the zai usage fetcher already applies.
 * `tokens_limit_weekly` is legitimately absent on single-window plans, which
 * reads back as `null`, not an error.
 */
function readZaiUtilization(data: Record<string, unknown>): UsageUtilization {
	return {
		fiveHour: readNestedNumber(data, "tokens_limit", "percentage"),
		weekly: readNestedNumber(data, "tokens_limit_weekly", "percentage"),
	};
}

/**
 * nanogpt payload shape: `{ active: boolean, daily: {percentUsed}, monthly:
 * {percentUsed}, ... }`, with `percentUsed` a 0-1 decimal. An inactive
 * (pay-as-you-go) account has no usage window at all, matching
 * `getRepresentativeNanoGPTUtilization`'s null-on-inactive precedent
 * elsewhere in the codebase.
 *
 * The two-slot fiveHour/weekly schema is reused to mean "daily" and
 * "monthly" for nanogpt specifically — an intentional mapping, not a
 * mismatch with the window names.
 */
function readNanoGptUtilization(
	data: Record<string, unknown>,
): UsageUtilization {
	if (data.active === false) {
		return { fiveHour: null, weekly: null };
	}

	const toPercent = (parentKey: string): number | null => {
		const raw = readNestedNumber(data, parentKey, "percentUsed");
		return raw === null ? null : raw * 100;
	};

	return {
		fiveHour: toPercent("daily"),
		weekly: toPercent("monthly"),
	};
}

/**
 * Read the 5-hour and weekly utilization out of a usage payload.
 *
 * `provider` selects the payload shape to parse. Anthropic, codex, xai,
 * minimax and any unrecognized/omitted provider all fall through to the
 * Anthropic-shaped parsing below — codex and xai already report in that
 * shape, and minimax's fetcher (`parseMinimaxTokenPlanResponse`) normalizes
 * its response to the same `five_hour`/`seven_day` flat fields before it
 * reaches this function, so no dedicated branch is needed for any of them.
 * zai and nanogpt have their own payload shapes and get dedicated parsing.
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
export function readUsageUtilization(
	payload: unknown,
	provider?: string | null,
): UsageUtilization {
	if (typeof payload !== "object" || payload === null) {
		return { fiveHour: null, weekly: null };
	}
	const data = payload as Record<string, unknown>;

	if (provider === "zai") return readZaiUtilization(data);
	if (provider === "nanogpt") return readNanoGptUtilization(data);

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

/**
 * Providers whose usage poller actually evaluates pause thresholds today
 * (`applyUsagePauseThresholds` in apps/server/src/server.ts, wired into
 * `startUsagePollingWithRefresh`'s `onSnapshot` callback).
 *
 * `readUsageUtilization` now understands anthropic, codex and xai (the
 * shared flat `five_hour`/`seven_day`/`limits[]` shape), zai and nanogpt
 * (their own dedicated payload shapes), and minimax (whose fetcher already
 * normalizes its response to the same flat shape before it reaches
 * `readUsageUtilization`, so it rides the anthropic/codex/xai path with no
 * dedicated branch).
 *
 * Two providers remain excluded, for different reasons:
 *   - `kilo` reports a dollar-credits balance, not a percentage window —
 *     there is no "utilization" to compare a threshold against.
 *   - `alibaba-coding-plan` has no pollable usage API at all; reading its
 *     usage would require session-cookie auth against Alibaba's website,
 *     which has never been implemented.
 *
 * Not to be confused with `supportsRefreshBackedUsagePolling` in
 * apps/server/src/server.ts, which gates a strict subset of this list — only
 * anthropic/codex/xai are polled through the OAuth-refresh-backed path.
 * zai/nanogpt/minimax support pause thresholds too, but are polled through
 * their own dedicated bootstrap blocks with their own `onSnapshot` wiring.
 */
export function supportsUsagePauseThreshold(
	provider: string | null | undefined,
): boolean {
	return (
		provider === "anthropic" ||
		provider === "codex" ||
		provider === "xai" ||
		provider === "zai" ||
		provider === "nanogpt" ||
		provider === "minimax"
	);
}
