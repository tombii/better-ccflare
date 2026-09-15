import { describe, expect, it } from "bun:test";
import { isUsageExhausted } from "@better-ccflare/core";
import type { UsageData } from "../usage-fetcher";
import { getRepresentativeUsageSnapshot } from "../usage-fetcher";

/**
 * The pairing three admission gates share — account selection, the
 * auto-refresh probe skip and the /health usage_exhausted counter. What each
 * of them needs from it is that a null snapshot never reads as "exhausted"
 * and that the reset belongs to the window the utilization came from.
 */
describe("getRepresentativeUsageSnapshot", () => {
	it("has no opinion when nothing was ever polled", () => {
		expect(getRepresentativeUsageSnapshot(null, "codex")).toBeNull();
		expect(getRepresentativeUsageSnapshot(undefined, "codex")).toBeNull();
	});

	it("has no opinion when the payload exposes no utilization surface", () => {
		// An empty payload names no window, so there is no percentage to gate
		// on — distinct from a real 0%, which would be a routable account.
		const empty = {} as unknown as UsageData;
		expect(getRepresentativeUsageSnapshot(empty, "codex")).toBeNull();
	});

	it("takes the exhausted window's utilization and that window's reset", () => {
		// The incident shape: a spent weekly window four days out while the
		// five-hour window is nearly empty and resets within the hour. Pairing
		// 100% with the five-hour reset is what let the staleness guard clear
		// the account an hour later and re-probe it.
		const weeklyExhausted = {
			five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00.000Z" },
			seven_day: { utilization: 100, resets_at: "2030-01-05T00:00:00.000Z" },
		} as unknown as UsageData;

		const snapshot = getRepresentativeUsageSnapshot(weeklyExhausted, "codex");

		expect(snapshot).toEqual({
			utilization: 100,
			resetMs: new Date("2030-01-05T00:00:00.000Z").getTime(),
		});
		expect(
			isUsageExhausted(
				snapshot?.utilization ?? null,
				snapshot?.resetMs,
				Date.parse("2030-01-02T00:00:00.000Z"),
			),
		).toBe(true);
	});
});
