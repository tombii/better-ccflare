import {
	computeWindowStartMs,
	getModelFamily,
	weeklyScopedWindowKey,
} from "@better-ccflare/core";
import type { AnyUsageData } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";

const RETRY_AFTER_SECONDS = 60;

interface UsageWindowSnapshot {
	utilization: number;
	resetAtMs: number;
	window: string;
	/** Set for per-model weekly caps (weekly_scoped); drives model-aware throttling. */
	modelFamily?: string;
	/** True for a weekly_scoped (per-model) cap — even when its family is unknown. */
	scoped?: boolean;
}

// Minimal shape of Anthropic's generic limits[] entries (see providers UsageLimit).
interface AnthropicLimit {
	kind?: string;
	percent?: number | null;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string } | null } | null;
}

export interface UsageThrottleSettings {
	fiveHourEnabled: boolean;
	weeklyEnabled: boolean;
}

export interface UsageThrottleStatus {
	throttleUntil: number | null;
	throttledWindows: string[];
}

function collectWindows(data: AnyUsageData | null): UsageWindowSnapshot[] {
	if (!data || typeof data !== "object") return [];

	const windows: UsageWindowSnapshot[] = [];

	const pushWindow = (
		window: string,
		utilization: number | null | undefined,
		resetAtMs: number | null | undefined,
		modelFamily?: string,
		scoped?: boolean,
	) => {
		if (
			typeof utilization !== "number" ||
			!Number.isFinite(utilization) ||
			typeof resetAtMs !== "number" ||
			!Number.isFinite(resetAtMs)
		) {
			return;
		}

		windows.push({
			utilization,
			resetAtMs,
			window,
			modelFamily,
			scoped,
		});
	};

	// PRIMARY: Anthropic's generic limits[] array. Checked FIRST — current payloads
	// carry BOTH the flat windows and limits[], and per-model caps live only here.
	// session -> five_hour, weekly_all -> seven_day, weekly_scoped -> seven_day_<slug>
	// (with modelFamily so throttling can be scoped to the request's model).
	if (Array.isArray((data as { limits?: unknown }).limits)) {
		const limits = (data as { limits: AnthropicLimit[] }).limits;
		let hasSession = false;
		let hasWeeklyAll = false;
		for (const l of limits) {
			if (!l || typeof l.percent !== "number") continue;
			const resetMs = l.resets_at ? new Date(l.resets_at).getTime() : null;
			if (l.kind === "session") {
				pushWindow("five_hour", l.percent, resetMs);
				hasSession = true;
			} else if (l.kind === "weekly_all") {
				pushWindow("seven_day", l.percent, resetMs);
				hasWeeklyAll = true;
			} else if (l.kind === "weekly_scoped") {
				const name = l.scope?.model?.display_name?.trim();
				if (!name) continue;
				pushWindow(
					weeklyScopedWindowKey(name),
					l.percent,
					resetMs,
					getModelFamily(name) ?? undefined,
					true,
				);
			}
		}
		// Supplement the account-level windows (five_hour / seven_day) from the flat
		// payload whenever limits[] did NOT carry them (per-kind, so no double-count):
		// a payload with only per-model scoped rows must still throttle on an
		// exhausted flat ACCOUNT cap, and an empty limits[] falls back to flat too.
		const flat = data as {
			five_hour?: { utilization?: number | null; resets_at?: string | null };
			seven_day?: { utilization?: number | null; resets_at?: string | null };
		};
		if (!hasSession && flat.five_hour) {
			pushWindow(
				"five_hour",
				flat.five_hour.utilization,
				flat.five_hour.resets_at
					? new Date(flat.five_hour.resets_at).getTime()
					: null,
			);
		}
		if (!hasWeeklyAll && flat.seven_day) {
			pushWindow(
				"seven_day",
				flat.seven_day.utilization,
				flat.seven_day.resets_at
					? new Date(flat.seven_day.resets_at).getTime()
					: null,
			);
		}
		// Return unless nothing usable was collected (empty limits[] AND no flat
		// account windows), in which case fall through to the other shape branches.
		if (windows.length > 0) return windows;
	}

	if ("five_hour" in data && "seven_day" in data) {
		const anthropicLike = data as {
			five_hour?: { utilization?: number | null; resets_at?: string | null };
			seven_day?: { utilization?: number | null; resets_at?: string | null };
			seven_day_opus?: {
				utilization?: number | null;
				resets_at?: string | null;
			};
			seven_day_sonnet?: {
				utilization?: number | null;
				resets_at?: string | null;
			};
		};

		pushWindow(
			"five_hour",
			anthropicLike.five_hour?.utilization,
			anthropicLike.five_hour?.resets_at
				? new Date(anthropicLike.five_hour.resets_at).getTime()
				: null,
		);
		pushWindow(
			"seven_day",
			anthropicLike.seven_day?.utilization,
			anthropicLike.seven_day?.resets_at
				? new Date(anthropicLike.seven_day.resets_at).getTime()
				: null,
		);
		pushWindow(
			"seven_day_opus",
			anthropicLike.seven_day_opus?.utilization,
			anthropicLike.seven_day_opus?.resets_at
				? new Date(anthropicLike.seven_day_opus.resets_at).getTime()
				: null,
		);
		pushWindow(
			"seven_day_sonnet",
			anthropicLike.seven_day_sonnet?.utilization,
			anthropicLike.seven_day_sonnet?.resets_at
				? new Date(anthropicLike.seven_day_sonnet.resets_at).getTime()
				: null,
		);
		return windows;
	}

	if ("tokens_limit" in data || "time_limit" in data) {
		const zai = data as {
			tokens_limit?: { percentage?: number; resetAt?: number | null } | null;
		};
		pushWindow(
			"tokens_limit",
			zai.tokens_limit?.percentage,
			zai.tokens_limit?.resetAt,
		);
		return windows;
	}

	if ("active" in data && "daily" in data && "monthly" in data) {
		const nanogpt = data as {
			active?: boolean;
			daily?: { percentUsed?: number; resetAt?: number };
			monthly?: { percentUsed?: number; resetAt?: number };
		};
		if (nanogpt.active) {
			pushWindow(
				"daily",
				typeof nanogpt.daily?.percentUsed === "number"
					? nanogpt.daily.percentUsed * 100
					: null,
				nanogpt.daily?.resetAt,
			);
			pushWindow(
				"monthly",
				typeof nanogpt.monthly?.percentUsed === "number"
					? nanogpt.monthly.percentUsed * 100
					: null,
				nanogpt.monthly?.resetAt,
			);
		}
		return windows;
	}

	if ("weekly" in data && "monthly" in data && "five_hour" in data) {
		const alibaba = data as {
			five_hour?: { percentUsed?: number; resetAt?: number | null };
			weekly?: { percentUsed?: number; resetAt?: number | null };
			monthly?: { percentUsed?: number; resetAt?: number | null };
		};
		pushWindow(
			"five_hour",
			alibaba.five_hour?.percentUsed,
			alibaba.five_hour?.resetAt,
		);
		pushWindow("weekly", alibaba.weekly?.percentUsed, alibaba.weekly?.resetAt);
		pushWindow(
			"monthly",
			alibaba.monthly?.percentUsed,
			alibaba.monthly?.resetAt,
		);
		return windows;
	}

	return windows;
}

function isWindowThrottlingEnabled(
	window: string,
	settings: UsageThrottleSettings,
): boolean {
	// Five-hour-class windows gate on the 5h setting; everything else — seven_day,
	// any per-model seven_day_<slug>, weekly, monthly, and unknown future windows —
	// gates on the weekly setting (so a dynamic scoped window never silently no-ops).
	if (
		window === "five_hour" ||
		window === "daily" ||
		window === "tokens_limit"
	) {
		return settings.fiveHourEnabled;
	}
	return settings.weeklyEnabled;
}

export function getUsageThrottleStatus(
	data: AnyUsageData | null,
	settings: UsageThrottleSettings,
	now = Date.now(),
	opts?: { requestModel?: string | null; scopedMode?: "match" | "all" },
): UsageThrottleStatus {
	// scopedMode "all" (default, display path) surfaces every per-model cap;
	// "match" (routing path) only counts a scoped cap when the request's model
	// family matches it.
	const scopedMode = opts?.scopedMode ?? "all";
	const requestFamily =
		opts?.requestModel != null ? getModelFamily(opts.requestModel) : null;
	const windows = collectWindows(data);
	let throttleUntil: number | null = null;
	const throttledWindows: string[] = [];

	for (const window of windows) {
		// A per-model (scoped) cap only throttles in "all" mode, or in "match" mode
		// when its family is KNOWN and equals the request's. An unmapped scoped cap
		// (modelFamily undefined) is skipped in match mode rather than throttling
		// every model; whole-account windows (not scoped) always throttle.
		if (
			window.scoped &&
			scopedMode !== "all" &&
			(window.modelFamily == null || window.modelFamily !== requestFamily)
		) {
			continue;
		}
		if (!isWindowThrottlingEnabled(window.window, settings)) continue;
		if (window.resetAtMs <= now) continue;
		const startMs = computeWindowStartMs(window.resetAtMs, window.window);
		if (startMs === null || startMs >= window.resetAtMs) continue;

		const durationMs = window.resetAtMs - startMs;
		const elapsedMs = now - startMs;
		if (elapsedMs <= 0) continue;

		const expectedPct = Math.min(
			100,
			Math.max(0, (elapsedMs / durationMs) * 100),
		);
		if (window.utilization <= expectedPct) continue;

		const resumeAt = Math.min(
			startMs + (window.utilization / 100) * durationMs,
			window.resetAtMs,
		);
		if (resumeAt <= now) continue;
		throttledWindows.push(window.window);
		if (throttleUntil === null || resumeAt > throttleUntil) {
			throttleUntil = resumeAt;
		}
	}

	return { throttleUntil, throttledWindows };
}

export function getUsageThrottleUntil(
	data: AnyUsageData | null,
	settings: UsageThrottleSettings,
	now = Date.now(),
	opts?: { requestModel?: string | null; scopedMode?: "match" | "all" },
): number | null {
	return getUsageThrottleStatus(data, settings, now, opts).throttleUntil;
}

export function createUsageThrottledResponse(accounts: Account[]): Response {
	const names = accounts.map((account) => account.name).join(", ");
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "overloaded_error",
				message: `Usage throttling is delaying requests for account(s): ${names}. Retry after ${RETRY_AFTER_SECONDS} seconds.`,
			},
		}),
		{
			status: 529,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(RETRY_AFTER_SECONDS),
			},
		},
	);
}
