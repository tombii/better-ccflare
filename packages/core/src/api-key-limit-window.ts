import type {
	ApiKeyLimitWindow,
	ApiKeyLimitWindowMode,
} from "@better-ccflare/types";

export const API_KEY_ROLLING_DURATION_MS: Record<ApiKeyLimitWindow, number> = {
	hour: 3_600_000,
	day: 86_400_000,
	week: 604_800_000,
	month: 2_592_000_000,
};
const dublin = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Europe/Dublin",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});
function localEpoch(ms: number): number {
	const parts = Object.fromEntries(
		dublin.formatToParts(ms).map((p) => [p.type, p.value]),
	);
	return Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);
}
/** Convert a Dublin wall-clock midnight to epoch time; independent of host TZ. */
function midnightEpoch(wallMs: number): number {
	let guess = wallMs;
	for (let i = 0; i < 4; i++) guess += wallMs - localEpoch(guess);
	return guess;
}
export function apiKeyLimitWindowBounds(
	window: ApiKeyLimitWindow,
	mode: ApiKeyLimitWindowMode,
	nowMs: number,
): { startMs: number; endMs: number } {
	if (mode === "rolling")
		return {
			startMs: nowMs - API_KEY_ROLLING_DURATION_MS[window],
			endMs: nowMs + API_KEY_ROLLING_DURATION_MS[window],
		};
	const wall = new Date(localEpoch(nowMs));
	if (window === "hour") {
		// The two occurrences of the autumn clock hour have distinct boundaries.
		const startMs =
			nowMs -
			wall.getUTCMinutes() * 60_000 -
			wall.getUTCSeconds() * 1000 -
			(((nowMs % 1000) + 1000) % 1000);
		return { startMs, endMs: startMs + 3_600_000 };
	}
	let start = Date.UTC(
		wall.getUTCFullYear(),
		wall.getUTCMonth(),
		wall.getUTCDate(),
	);
	let end: number;
	if (window === "month") {
		start = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1);
		end = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1);
	} else if (window === "week") {
		start -= ((wall.getUTCDay() + 6) % 7) * 86_400_000;
		end = start + 7 * 86_400_000;
	} else end = start + 86_400_000;
	return { startMs: midnightEpoch(start), endMs: midnightEpoch(end) };
}
