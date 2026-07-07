/**
 * Pure, testable display helpers for RateLimitProgress.
 *
 * Anthropic's usage endpoint now reports the authoritative picture in a generic
 * `limits[]` array (kinds `session` / `weekly_all` / `weekly_scoped`). Per-model
 * weekly caps (Fable/Opus/Sonnet) live ONLY there as `weekly_scoped` entries;
 * the legacy flat `seven_day_*` keys are null on current plans. We render from
 * `limits[]` when present and fall back to the legacy flat windows otherwise.
 */
import { weeklyScopedWindowKey } from "@better-ccflare/core";
import type { AnthropicUsageData, UsageLimit } from "@better-ccflare/types";

/** A single progress-bar row rendered by RateLimitProgress. */
export interface UsageDisplay {
	utilization: number | null;
	/** Internal window key (drives pace marker + reset formatting). */
	window: string | null;
	resetTime: string | null;
	/** Explicit display label (used for limits[] rows); falls back to formatWindowName(window). */
	label?: string;
	/** Grouping bucket for the UI ("session" | "weekly"). */
	group?: "session" | "weekly";
	/** Anthropic-provided severity ("normal" | "warning" | "critical") — drives bar color. */
	severity?: string;
	/** True when this is the currently-binding limit (from limits[].is_active). */
	isActive?: boolean;
}

/**
 * Runtime type guard for a legacy Anthropic usage window.
 *
 * Requires BOTH `resets_at` and `utilization` keys, which intentionally EXCLUDES
 * `extra_usage` (has `utilization` but no `resets_at`) and opaque codename fields.
 */
export function isUsageWindow(
	v: unknown,
): v is { utilization: number | null; resets_at: string | null } {
	return (
		typeof v === "object" &&
		v !== null &&
		"resets_at" in v &&
		"utilization" in v
	);
}

/** True for the account-level weekly window and every model tier window. */
export function isWeeklyWindow(window: string): boolean {
	return window === "seven_day" || window.startsWith("seven_day_");
}

/**
 * Human-friendly label for a window key (used for legacy rows that carry no
 * explicit label). Anthropic weekly tiers map `seven_day_<tier>` -> "<Tier> (Weekly)".
 */
export function formatWindowName(window: string | null): string {
	if (!window) return "window";
	switch (window) {
		case "five_hour":
			return "5-hour";
		case "seven_day":
			return "Weekly";
		case "daily":
			return "Daily";
		case "weekly":
			return "Weekly";
		case "monthly":
			return "Monthly";
		case "time_limit":
			return "Time Quota";
		case "tokens_limit":
			return "5-hour";
		case "credits":
			return "Grok credits";
	}

	if (window.startsWith("seven_day_")) {
		const tier = window.slice("seven_day_".length);
		if (tier.length > 0) {
			const label = tier.charAt(0).toUpperCase() + tier.slice(1);
			return `${label} (Weekly)`;
		}
	}

	return window.replace("_", " ");
}

/** Resolve the display label for a row (explicit label wins). */
export function displayLabel(row: UsageDisplay): string {
	return row.label ?? formatWindowName(row.window);
}

/** Map an Anthropic severity (or a >=100% fallback) to a bar-color token. */
export function severityColor(
	severity: string | undefined,
	utilization: number | null,
): "critical" | "warning" | "normal" {
	if (severity === "critical" || severity === "warning") return severity;
	if (severity === "normal") return "normal";
	// No severity provided (legacy rows): derive from utilization.
	if (utilization != null && utilization >= 100) return "critical";
	if (utilization != null && utilization >= 90) return "warning";
	return "normal";
}

/**
 * Build display rows from Anthropic's generic `limits[]` array — the primary,
 * authoritative source. Order follows the array (session, weekly_all, then
 * weekly_scoped). Malformed entries (no `percent`, or a scoped entry without a
 * model display name) are skipped. `is_active` is NOT used to filter — every
 * valid limit renders; the active one is only flagged for highlighting.
 */
export function collectAnthropicLimitRows(
	limits: UsageLimit[],
): UsageDisplay[] {
	const rows: UsageDisplay[] = [];
	// Track every scoped window key already emitted so duplicates get a unique
	// suffix that can't collide with each other OR with a real model whose slug
	// already ends in _<n> (e.g. a "Fable" duplicate vs a model named "Fable 1").
	const usedWindows = new Set<string>();
	for (const limit of limits) {
		if (!limit || limit.percent == null) continue;
		const base = {
			utilization: limit.percent,
			resetTime: limit.resets_at,
			severity: limit.severity,
			isActive: limit.is_active === true,
		};
		if (limit.kind === "session") {
			rows.push({
				...base,
				window: "five_hour",
				label: "5-hour",
				group: "session",
			});
		} else if (limit.kind === "weekly_all") {
			rows.push({
				...base,
				window: "seven_day",
				label: "Weekly",
				group: "weekly",
			});
		} else if (limit.kind === "weekly_scoped") {
			const name = limit.scope?.model?.display_name?.trim();
			if (!name) continue;
			const baseWindow = weeklyScopedWindowKey(name);
			// First occurrence keeps the byte-stable key + label (throttle-window
			// match, pace marker, snapshot tests). Later duplicates get the next free
			// numeric suffix, checked against ALL used scoped keys so it can never
			// collide with another duplicate or a real model slug; still
			// seven_day_-prefixed so the pace marker applies. surface/model.id is
			// label-only context.
			let window = baseWindow;
			let n = 0;
			while (usedWindows.has(window)) {
				n += 1;
				window = `${baseWindow}_${n}`;
			}
			usedWindows.add(window);
			const context =
				limit.scope?.surface?.trim() || limit.scope?.model?.id?.trim();
			rows.push({
				...base,
				window,
				label:
					window === baseWindow
						? `${name} (Weekly)`
						: `${name} (Weekly, ${context ?? n})`,
				group: "weekly",
			});
		}
		// Unknown kinds are intentionally not rendered.
	}
	// Stable-partition session rows before weekly rows so the Session / Weekly
	// group headers render correctly regardless of the order limits[] arrives in.
	const sessionRows = rows.filter((r) => r.group === "session");
	const weeklyRows = rows.filter((r) => r.group !== "session");
	return [...sessionRows, ...weeklyRows];
}

// Legacy per-model tier keys (all null on current plans; kept only as a fallback
// for older API versions that still populate them and omit `limits[]`).
const LEGACY_MODEL_TIER_WINDOWS = [
	"seven_day_opus",
	"seven_day_sonnet",
	"seven_day_fable",
	"seven_day_haiku",
] as const;

/**
 * Build the ordered list of progress-bar rows for an Anthropic-style payload.
 *
 * PRIMARY: when `limits[]` is present (an array — never the NanoGPT `limits`
 * object), rows come entirely from it via collectAnthropicLimitRows.
 * FALLBACK: otherwise, the legacy flat windows (five_hour / seven_day / the
 * per-model allowlist) are used, matching the prior behavior.
 */
export function collectAnthropicUsageRows(
	usage: AnthropicUsageData | null | undefined,
	fallback: { utilization: number | null; resetTime: string | null },
): UsageDisplay[] {
	// PRIMARY path: the generic limits[] array (disambiguated from NanoGPT's
	// object-shaped `limits` by Array.isArray).
	if (usage && Array.isArray(usage.limits)) {
		const rows = collectAnthropicLimitRows(usage.limits);
		// Only take the limits[] result if it produced usable rows. An empty
		// array, all-null percents, or scoped entries missing a display name
		// would otherwise blank the card — fall through to the legacy flat windows
		// instead, keeping the account row consistent with the pool tiles
		// (pool-usage.ts also falls back per kind).
		if (rows.length > 0) return rows;
	}

	// FALLBACK path: legacy flat windows.
	const data = (usage ?? {}) as Record<
		string,
		{ utilization: number | null; resets_at: string | null } | undefined
	>;
	const rows: UsageDisplay[] = [];

	const fiveHour = data.five_hour;
	if (isUsageWindow(fiveHour)) {
		rows.push({
			utilization: fiveHour.utilization,
			window: "five_hour",
			resetTime: fiveHour.resets_at,
		});
	} else {
		rows.push({
			utilization: fallback.utilization,
			window: "five_hour",
			resetTime: fallback.resetTime,
		});
	}

	const sevenDay = data.seven_day;
	if (isUsageWindow(sevenDay) && sevenDay.utilization != null) {
		rows.push({
			utilization: sevenDay.utilization,
			window: "seven_day",
			resetTime: sevenDay.resets_at,
		});
	} else {
		rows.push({ utilization: null, window: "seven_day", resetTime: null });
	}

	for (const key of LEGACY_MODEL_TIER_WINDOWS) {
		const window = data[key];
		if (
			isUsageWindow(window) &&
			window.utilization != null &&
			window.resets_at !== null
		) {
			rows.push({
				utilization: window.utilization,
				window: key,
				resetTime: window.resets_at,
			});
		}
	}

	return rows;
}
