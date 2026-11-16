import { apiKeyLimitWindowBounds } from "@better-ccflare/core";
import { BadRequest } from "@better-ccflare/errors";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_CUSTOM_RANGE_MS = 400 * DAY;
const MIN_CUSTOM_DATE_MS = Date.UTC(2000, 0, 1);
const MAX_CUSTOM_DATE_MS = Date.UTC(2100, 0, 1);

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
		if (startMs < MIN_CUSTOM_DATE_MS || endMs > MAX_CUSTOM_DATE_MS) {
			throw BadRequest(
				"Custom range dates must be between 2000-01-01 and 2100-01-01",
			);
		}
		const duration = endMs - startMs;
		if (duration > MAX_CUSTOM_RANGE_MS) {
			throw BadRequest("Custom range must not exceed 400 days");
		}
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
	if (
		!Number.isFinite(startMs) ||
		!Number.isFinite(endMs) ||
		endMs <= startMs
	) {
		return 0;
	}
	const first = apiKeyLimitWindowBounds("month", "calendar", startMs);
	const last = apiKeyLimitWindowBounds("month", "calendar", endMs - 1);
	if (first.startMs === last.startMs) {
		return (endMs - startMs) / (first.endMs - first.startMs);
	}
	// Summer month starts fall on the previous UTC date. A day into each
	// Dublin month gives its UTC year/month without another timezone conversion.
	const firstMonth = new Date(first.startMs + DAY);
	const lastMonth = new Date(last.startMs + DAY);
	const wholeMonths =
		(lastMonth.getUTCFullYear() - firstMonth.getUTCFullYear()) * 12 +
		lastMonth.getUTCMonth() -
		firstMonth.getUTCMonth() -
		1;
	return (
		(first.endMs - startMs) / (first.endMs - first.startMs) +
		wholeMonths +
		(endMs - last.startMs) / (last.endMs - last.startMs)
	);
}
