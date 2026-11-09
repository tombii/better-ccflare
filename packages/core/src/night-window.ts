/**
 * Provider-agnostic "night window" time logic.
 *
 * A night window is a local-time range (e.g. 22:00-08:00 in Europe/Kyiv) used
 * by providers that offer a cheaper / lower-priority tier outside peak hours.
 * This module knows nothing about any provider, header name, or tier value: it
 * only answers "does `now` fall inside this window?".
 *
 * Everything here is pure: no DB, no HTTP, no ambient `TZ`. Zone offsets are
 * resolved with `Intl.DateTimeFormat` for the explicit zone name and all
 * arithmetic is done on UTC milliseconds.
 */

export interface NightWindow {
	startMin: number;
	endMin: number;
	zone: string;
}

const DEFAULT_ZONE = "UTC";
const MINUTE_MS = 60_000;

const SPEC_RE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

/**
 * Parse a "HH:MM-HH:MM" (24h) spec and an IANA zone name.
 *
 * Returns null for anything malformed or for an invalid zone. Never throws.
 * A null/undefined/empty zone defaults to UTC.
 */
export function parseNightWindow(
	spec: string | null | undefined,
	zone: string | null | undefined,
): NightWindow | null {
	if (typeof spec !== "string") return null;
	const match = SPEC_RE.exec(spec.trim());
	if (!match) return null;

	const sh = Number(match[1]);
	const sm = Number(match[2]);
	const eh = Number(match[3]);
	const em = Number(match[4]);
	if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;

	const resolvedZone =
		typeof zone === "string" && zone.trim() !== "" ? zone.trim() : DEFAULT_ZONE;
	if (resolveOffsetMinutes(resolvedZone, Date.now()) === null) return null;

	return { startMin: sh * 60 + sm, endMin: eh * 60 + em, zone: resolvedZone };
}

/**
 * True when `nowMs` falls in [startMin, endMin) local to the window's zone.
 * start is inclusive, end is exclusive. Wrapping windows (start > end) are
 * supported; start === end is treated as an empty window.
 */
export function isInNightWindow(window: NightWindow, nowMs: number): boolean {
	if (window.startMin === window.endMin) return false;
	if (!Number.isFinite(nowMs)) return false;

	const offset = resolveOffsetMinutes(window.zone, nowMs);
	if (offset === null) return false;

	const localMinute =
		Math.floor((nowMs + offset * MINUTE_MS) / MINUTE_MS) % 1440;
	if (window.startMin < window.endMin) {
		return localMinute >= window.startMin && localMinute < window.endMin;
	}
	return localMinute >= window.startMin || localMinute < window.endMin;
}

// Per-minute memo of zone offsets. A request burst in the same minute reuses
// one Intl call instead of one per request; the key includes the minute bucket
// so a DST transition is picked up within a minute. Bounded by a plain clear:
// the map never holds more than a handful of zones in practice, and a full
// flush on overflow is cheaper and simpler than an LRU.
const offsetCache = new Map<string, number>();

function resolveOffsetMinutes(zone: string, nowMs: number): number | null {
	const key = `${zone}:${Math.floor(nowMs / MINUTE_MS)}`;
	const cached = offsetCache.get(key);
	if (cached !== undefined) return cached;

	let offset: number;
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		}).formatToParts(new Date(nowMs));

		const get = (type: string) =>
			Number(parts.find((p) => p.type === type)?.value);
		let hour = get("hour");
		// Some ICU versions render midnight as "24" with hour12:false.
		if (hour === 24) hour = 0;
		const asUtc = Date.UTC(
			get("year"),
			get("month") - 1,
			get("day"),
			hour,
			get("minute"),
			get("second"),
		);
		// Both operands are whole seconds; round to absorb sub-minute drift.
		offset = Math.round((asUtc - nowMs) / MINUTE_MS);
	} catch {
		return null;
	}

	if (offsetCache.size > 64) offsetCache.clear();
	offsetCache.set(key, offset);
	return offset;
}
