import { describe, expect, it } from "bun:test";
import {
	isInNightWindow,
	type NightWindow,
	parseNightWindow,
} from "./night-window";

const utc = (iso: string) => Date.parse(iso);

function window(spec: string, zone = "UTC"): NightWindow {
	const parsed = parseNightWindow(spec, zone);
	if (!parsed) throw new Error(`expected ${spec} (${zone}) to parse`);
	return parsed;
}

describe("parseNightWindow", () => {
	it.each([
		[null],
		[undefined],
		[""],
		["   "],
		["garbage"],
		["22:00"],
		["22:00-"],
		["-08:00"],
		["22:00-08:00-12:00"],
		["24:00-08:00"],
		["22:00-25:00"],
		["22:60-08:00"],
		["22:00-08:60"],
		["2:00-08:00"],
		["22:0-08:00"],
		["22.00-08.00"],
	])("returns null for malformed spec %p", (spec) => {
		expect(
			parseNightWindow(spec as string | null | undefined, "UTC"),
		).toBeNull();
	});

	it("parses a wrap window", () => {
		expect(parseNightWindow("22:00-08:00", "UTC")).toEqual({
			startMin: 22 * 60,
			endMin: 8 * 60,
			zone: "UTC",
		});
	});

	it("parses midnight boundaries", () => {
		expect(parseNightWindow("00:00-23:59", "UTC")).toEqual({
			startMin: 0,
			endMin: 23 * 60 + 59,
			zone: "UTC",
		});
	});

	it("defaults the zone to UTC when null/undefined/empty", () => {
		expect(parseNightWindow("22:00-08:00", null)?.zone).toBe("UTC");
		expect(parseNightWindow("22:00-08:00", undefined)?.zone).toBe("UTC");
		expect(parseNightWindow("22:00-08:00", "")?.zone).toBe("UTC");
	});

	it("keeps an explicit zone", () => {
		expect(parseNightWindow("22:00-08:00", "Europe/Kyiv")?.zone).toBe(
			"Europe/Kyiv",
		);
	});

	it("returns null for an invalid zone name", () => {
		expect(parseNightWindow("22:00-08:00", "Not/AZone")).toBeNull();
		expect(parseNightWindow("22:00-08:00", "../../etc/passwd")).toBeNull();
	});

	it("trims surrounding whitespace", () => {
		expect(parseNightWindow(" 22:00-08:00 ", "UTC")).toEqual({
			startMin: 1320,
			endMin: 480,
			zone: "UTC",
		});
	});
});

describe("isInNightWindow", () => {
	it("handles a wrapping window 22:00-08:00 in UTC", () => {
		const w = window("22:00-08:00");
		expect(isInNightWindow(w, utc("2026-11-09T23:00:00Z"))).toBe(true);
		expect(isInNightWindow(w, utc("2026-11-09T03:00:00Z"))).toBe(true);
		expect(isInNightWindow(w, utc("2026-11-09T07:59:00Z"))).toBe(true);
		expect(isInNightWindow(w, utc("2026-11-09T08:00:00Z"))).toBe(false);
		expect(isInNightWindow(w, utc("2026-11-09T21:59:00Z"))).toBe(false);
		expect(isInNightWindow(w, utc("2026-11-09T12:00:00Z"))).toBe(false);
		expect(isInNightWindow(w, utc("2026-11-09T00:00:00Z"))).toBe(true);
	});

	it("handles a non-wrapping window 01:00-05:00 in UTC", () => {
		const w = window("01:00-05:00");
		expect(isInNightWindow(w, utc("2026-11-09T00:59:00Z"))).toBe(false);
		expect(isInNightWindow(w, utc("2026-11-09T01:00:00Z"))).toBe(true);
		expect(isInNightWindow(w, utc("2026-11-09T04:59:00Z"))).toBe(true);
		expect(isInNightWindow(w, utc("2026-11-09T05:00:00Z"))).toBe(false);
		expect(isInNightWindow(w, utc("2026-11-09T12:00:00Z"))).toBe(false);
	});

	it("treats start === end as an empty window", () => {
		const w = window("03:00-03:00");
		expect(isInNightWindow(w, utc("2026-11-09T03:00:00Z"))).toBe(false);
		expect(isInNightWindow(w, utc("2026-11-09T03:01:00Z"))).toBe(false);
		expect(isInNightWindow(w, utc("2026-11-09T00:00:00Z"))).toBe(false);
	});

	it("resolves a named zone differently in winter and summer (Kyiv)", () => {
		// Europe/Kyiv is UTC+2 in winter (EET) and UTC+3 in summer (EEST).
		const w = window("02:00-03:00", "Europe/Kyiv");

		// Winter: 00:00Z is 02:00 local -> start boundary inclusive.
		expect(isInNightWindow(w, utc("2026-01-15T00:00:00Z"))).toBe(true);
		// Winter: 01:00Z is 03:00 local -> end boundary exclusive.
		expect(isInNightWindow(w, utc("2026-01-15T01:00:00Z"))).toBe(false);
		// Winter: 00:59Z is 02:59 local -> inside.
		expect(isInNightWindow(w, utc("2026-01-15T00:59:00Z"))).toBe(true);

		// Summer: the same 00:00Z instant is 03:00 local -> outside.
		expect(isInNightWindow(w, utc("2026-07-15T00:00:00Z"))).toBe(false);
		// Summer: 23:00Z the previous day is 02:00 local -> start inclusive.
		expect(isInNightWindow(w, utc("2026-07-14T23:00:00Z"))).toBe(true);
		// Summer: 23:59Z is 02:59 local -> inside.
		expect(isInNightWindow(w, utc("2026-07-14T23:59:00Z"))).toBe(true);
		// Summer: 00:59Z is 03:59 local -> outside.
		expect(isInNightWindow(w, utc("2026-07-15T00:59:00Z"))).toBe(false);
	});

	it("never reads ambient TZ (UTC arithmetic only)", () => {
		const w = window("22:00-08:00", "UTC");
		// 22:00 UTC on a fixed day must be in-window regardless of host TZ.
		expect(isInNightWindow(w, utc("2026-11-09T22:00:00Z"))).toBe(true);
	});
});
