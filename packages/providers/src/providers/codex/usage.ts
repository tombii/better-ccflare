import type { UsageData, UsageWindow } from "../../usage-fetcher";

export interface ParseCodexUsageHeadersOptions {
	baseTimeMs?: number;
	allowRelativeResetAfter?: boolean;
	defaultUtilization?: number;
}

const DEFAULT_UTILIZATION = 0;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;

function parseNumber(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(timestampMs: number | null): string | null {
	if (timestampMs === null || !Number.isFinite(timestampMs)) return null;
	try {
		return new Date(timestampMs).toISOString();
	} catch {
		return null;
	}
}

function parseResetAtSeconds(value: string | null): string | null {
	const parsed = parseNumber(value);
	if (parsed === null) return null;
	return toIsoString(parsed * 1000);
}

function parseResetAfterSeconds(
	value: string | null,
	baseTimeMs: number,
	allowRelativeResetAfter: boolean,
): string | null {
	if (!allowRelativeResetAfter || !Number.isFinite(baseTimeMs)) return null;
	const parsed = parseNumber(value);
	if (parsed === null) return null;
	return toIsoString(baseTimeMs + parsed * 1000);
}

function toUsageWindow(
	utilization: number | null,
	resetsAt: string | null,
): UsageWindow | null {
	if (utilization === null && resetsAt === null) return null;
	return {
		utilization: utilization ?? 0,
		resets_at: resetsAt,
	};
}

function pickWindowSlot(
	windowMinutes: number | null,
): "five_hour" | "seven_day" | null {
	if (windowMinutes === null) return null;
	if (windowMinutes <= FIVE_HOUR_WINDOW_MINUTES) return "five_hour";
	if (windowMinutes >= SEVEN_DAY_WINDOW_MINUTES) return "seven_day";
	return null;
}

function readWindow(
	headers: Headers,
	prefix: "primary" | "secondary",
	baseTimeMs: number,
	allowRelativeResetAfter: boolean,
	defaultUtilization: number,
): {
	window: "five_hour" | "seven_day" | null;
	data: UsageWindow | null;
} {
	const windowMinutes = parseNumber(
		headers.get(`x-codex-${prefix}-window-minutes`),
	);
	const utilization = parseNumber(
		headers.get(`x-codex-${prefix}-used-percent`),
	);
	const resetsAt =
		parseResetAtSeconds(headers.get(`x-codex-${prefix}-reset-at`)) ??
		parseResetAfterSeconds(
			headers.get(`x-codex-${prefix}-reset-after-seconds`),
			baseTimeMs,
			allowRelativeResetAfter,
		);

	// Only produce a window entry when at least one relevant header was present
	const hasAnyHeader =
		windowMinutes !== null || utilization !== null || resetsAt !== null;

	return {
		window: pickWindowSlot(windowMinutes),
		data: hasAnyHeader
			? toUsageWindow(utilization ?? defaultUtilization, resetsAt)
			: null,
	};
}

export function parseCodexUsageHeaders(
	headers: Headers,
	options: ParseCodexUsageHeadersOptions = {},
): UsageData | null {
	const {
		baseTimeMs = Date.now(),
		allowRelativeResetAfter = true,
		defaultUtilization = DEFAULT_UTILIZATION,
	} = options;
	const primary = readWindow(
		headers,
		"primary",
		baseTimeMs,
		allowRelativeResetAfter,
		defaultUtilization,
	);
	const secondary = readWindow(
		headers,
		"secondary",
		baseTimeMs,
		allowRelativeResetAfter,
		defaultUtilization,
	);

	const legacyFiveHourReset = parseResetAtSeconds(
		headers.get("x-codex-5h-reset-at"),
	);
	const legacySevenDayReset = parseResetAtSeconds(
		headers.get("x-codex-7d-reset-at"),
	);

	const fiveHour =
		(primary.window === "five_hour" ? primary.data : null) ??
		(secondary.window === "five_hour" ? secondary.data : null) ??
		(legacyFiveHourReset
			? toUsageWindow(defaultUtilization, legacyFiveHourReset)
			: null);
	const sevenDay =
		(primary.window === "seven_day" ? primary.data : null) ??
		(secondary.window === "seven_day" ? secondary.data : null) ??
		(legacySevenDayReset
			? toUsageWindow(defaultUtilization, legacySevenDayReset)
			: null);

	if (!fiveHour && !sevenDay) {
		return null;
	}

	return {
		five_hour: fiveHour ?? { utilization: defaultUtilization, resets_at: null },
		seven_day: sevenDay ?? { utilization: defaultUtilization, resets_at: null },
	};
}
