import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearAllProbeBackoff,
	clearProbeBackoff,
	compareAccountPreference,
	isProbeBackedOff,
	PROBE_BACKOFF_PENALTY_THRESHOLD_MS,
	preemptsOnPreference,
	probeBackoffRank,
	probeBackoffUntil,
	setProbeBackoff,
} from "./probe-backoff";

const NOW = 1_700_000_000_000;

beforeEach(() => {
	clearAllProbeBackoff();
});

afterEach(() => {
	clearAllProbeBackoff();
});

describe("probe backoff registry", () => {
	it("starts empty and reports an unknown account as fine", () => {
		expect(isProbeBackedOff("nobody", NOW)).toBe(false);
		expect(probeBackoffUntil("nobody")).toBeNull();
		expect(probeBackoffRank("nobody", NOW)).toBe(0);
	});

	it("holds an account until its deadline, then lets it go", () => {
		setProbeBackoff("acc", NOW + PROBE_BACKOFF_PENALTY_THRESHOLD_MS);

		expect(isProbeBackedOff("acc", NOW)).toBe(true);
		expect(probeBackoffUntil("acc")).toBe(
			NOW + PROBE_BACKOFF_PENALTY_THRESHOLD_MS,
		);

		// Read rather than swept: a passed deadline counts as clear on its own, so
		// a stale entry cannot penalise an account forever.
		expect(
			isProbeBackedOff("acc", NOW + PROBE_BACKOFF_PENALTY_THRESHOLD_MS + 1),
		).toBe(false);
	});

	it("treats the deadline itself as still backed off, and one ms later as clear", () => {
		setProbeBackoff("acc", NOW + 1000);

		expect(isProbeBackedOff("acc", NOW + 999)).toBe(true);
		expect(isProbeBackedOff("acc", NOW + 1000)).toBe(false);
	});

	it("forgets a single account without touching the others", () => {
		setProbeBackoff("a", NOW + 60_000);
		setProbeBackoff("b", NOW + 60_000);

		clearProbeBackoff("a");

		expect(isProbeBackedOff("a", NOW)).toBe(false);
		expect(isProbeBackedOff("b", NOW)).toBe(true);
	});
});

describe("compareAccountPreference", () => {
	const healthy = { id: "well", priority: 5 };
	const backedOff = { id: "sick", priority: 0 };

	it("falls back to plain priority when neither is backed off", () => {
		expect(compareAccountPreference(backedOff, healthy, NOW)).toBeLessThan(0);
	});

	it("puts a backed-off account last even when its priority is better", () => {
		setProbeBackoff(backedOff.id, NOW + 60_000);

		expect(compareAccountPreference(backedOff, healthy, NOW)).toBeGreaterThan(
			0,
		);
		expect(compareAccountPreference(healthy, backedOff, NOW)).toBeLessThan(0);
	});

	it("keeps priority as the tiebreaker inside the backed-off group", () => {
		setProbeBackoff("low", NOW + 60_000);
		setProbeBackoff("high", NOW + 60_000);

		expect(
			compareAccountPreference(
				{ id: "high", priority: 1 },
				{ id: "low", priority: 9 },
				NOW,
			),
		).toBeLessThan(0);
	});

	it("returns 0 for equals so callers can apply their own tiebreaker", () => {
		expect(
			compareAccountPreference(
				{ id: "x", priority: 3 },
				{ id: "y", priority: 3 },
				NOW,
			),
		).toBe(0);
	});
});

describe("preemptsOnPreference", () => {
	it("lets a strictly better priority take over", () => {
		expect(
			preemptsOnPreference(
				{ id: "a", priority: 0 },
				{ id: "b", priority: 5 },
				NOW,
			),
		).toBe(true);
	});

	it("does not let an equal priority take over", () => {
		expect(
			preemptsOnPreference(
				{ id: "a", priority: 5 },
				{ id: "b", priority: 5 },
				NOW,
			),
		).toBe(false);
	});

	it("never lets a backed-off account take over one that is fine", () => {
		setProbeBackoff("a", NOW + 60_000);

		expect(
			preemptsOnPreference(
				{ id: "a", priority: 0 },
				{ id: "b", priority: 9 },
				NOW,
			),
		).toBe(false);
	});

	it("lets a healthy account take over a backed-off incumbent it would otherwise lose to", () => {
		setProbeBackoff("b", NOW + 60_000);

		expect(
			preemptsOnPreference(
				{ id: "a", priority: 9 },
				{ id: "b", priority: 0 },
				NOW,
			),
		).toBe(true);
	});
});
