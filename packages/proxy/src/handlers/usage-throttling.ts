import type { AnyUsageData } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";

const RETRY_AFTER_SECONDS = 60;

type SupportedWindow =
	| "five_hour"
	| "seven_day"
	| "seven_day_opus"
	| "seven_day_sonnet"
	| "weekly"
	| "daily"
	| "monthly"
	| "tokens_limit";

interface UsageWindowSnapshot {
	utilization: number;
	resetAtMs: number;
	window: SupportedWindow;
}

export interface UsageThrottleSettings {
	fiveHourEnabled: boolean;
	weeklyEnabled: boolean;
}

export interface UsageThrottleStatus {
	throttleUntil: number | null;
	throttledWindows: SupportedWindow[];
}

function computeWindowStartMs(
	resetMs: number,
	window: SupportedWindow,
): number | null {
	if (!Number.isFinite(resetMs)) return null;

	if (window === "monthly") {
		const resetDate = new Date(resetMs);
		// Calculate actual calendar month duration (handles 28/29/30/31 days)
		const monthStart = Date.UTC(
			resetDate.getUTCFullYear(),
			resetDate.getUTCMonth(),
			1,
			0,
			0,
			0,
			0,
		);
		const nextMonthStart = Date.UTC(
			resetDate.getUTCFullYear(),
			resetDate.getUTCMonth() + 1,
			1,
			0,
			0,
			0,
			0,
		);
		const actualMonthDurationMs = nextMonthStart - monthStart;
		return resetMs - actualMonthDurationMs;
	}

	const durationMs = {
		five_hour: 5 * 60 * 60 * 1000,
		seven_day: 7 * 24 * 60 * 60 * 1000,
		seven_day_opus: 7 * 24 * 60 * 60 * 1000,
		seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
		weekly: 7 * 24 * 60 * 60 * 1000,
		daily: 24 * 60 * 60 * 1000,
		tokens_limit: 5 * 60 * 60 * 1000,
	}[window];

	return durationMs ? resetMs - durationMs : null;
}

function collectWindows(data: AnyUsageData | null): UsageWindowSnapshot[] {
	if (!data || typeof data !== "object") return [];

	const windows: UsageWindowSnapshot[] = [];

	const pushWindow = (
		window: SupportedWindow,
		utilization: number | null | undefined,
		resetAtMs: number | null | undefined,
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
		});
	};

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
	window: SupportedWindow,
	settings: UsageThrottleSettings,
): boolean {
	switch (window) {
		case "five_hour":
		case "daily":
		case "tokens_limit":
			return settings.fiveHourEnabled;
		case "seven_day":
		case "seven_day_opus":
		case "seven_day_sonnet":
		case "weekly":
		case "monthly":
			return settings.weeklyEnabled;
	}
}

export function getUsageThrottleStatus(
	data: AnyUsageData | null,
	settings: UsageThrottleSettings,
	now = Date.now(),
): UsageThrottleStatus {
	const windows = collectWindows(data);
	let throttleUntil: number | null = null;
	const throttledWindows: SupportedWindow[] = [];

	for (const window of windows) {
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
): number | null {
	return getUsageThrottleStatus(data, settings, now).throttleUntil;
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
