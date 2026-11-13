import { apiKeyLimitWindowBounds } from "@better-ccflare/core";
import { BadRequest } from "@better-ccflare/errors";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Absolute bounds shared by every usage aggregate, including custom ranges. */
export function apiKeyUsageRange(params: URLSearchParams, nowMs = Date.now()) {
	const requested = params.get("range") ?? "24h";
	if (requested === "custom") {
		const from = params.get("from");
		const to = params.get("to");
		const startMs = from ? Date.parse(from) : NaN;
		const endMs = to ? Date.parse(to) : NaN;
		if (
			!Number.isFinite(startMs) ||
			!Number.isFinite(endMs) ||
			endMs <= startMs
		) {
			throw BadRequest(
				"Custom range requires valid from and to dates, with from before to",
			);
		}
		const duration = endMs - startMs;
		return {
			range: requested,
			startMs,
			endMs,
			bucketMs: duration <= HOUR ? 60_000 : duration <= 7 * DAY ? HOUR : DAY,
		};
	}
	if (requested === "this_month" || requested === "last_month") {
		const current = apiKeyLimitWindowBounds("month", "calendar", nowMs);
		const bounds =
			requested === "last_month"
				? apiKeyLimitWindowBounds("month", "calendar", current.startMs - 1)
				: current;
		return {
			range: requested,
			startMs: bounds.startMs,
			endMs: requested === "last_month" ? bounds.endMs : nowMs,
			bucketMs: DAY,
		};
	}
	const durations: Record<string, number> = {
		"1h": HOUR,
		"6h": 6 * HOUR,
		"24h": DAY,
		"7d": 7 * DAY,
		"30d": 30 * DAY,
	};
	const range = requested in durations ? requested : "24h";
	return {
		range,
		startMs: nowMs - durations[range],
		endMs: nowMs,
		bucketMs:
			range === "1h"
				? 60_000
				: range === "6h"
					? 5 * 60_000
					: range === "30d"
						? DAY
						: HOUR,
	};
}

/** Fraction of Dublin calendar months intersected by a selected range. */
export function calendarMonthFraction(startMs: number, endMs: number): number {
	let fraction = 0;
	for (let cursor = startMs; cursor < endMs; ) {
		const month = apiKeyLimitWindowBounds("month", "calendar", cursor);
		const segmentEnd = Math.min(endMs, month.endMs);
		fraction += (segmentEnd - cursor) / (month.endMs - month.startMs);
		cursor = segmentEnd;
	}
	return fraction;
}
