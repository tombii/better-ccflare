import { describe, expect, it } from "bun:test";
import { isUsageExhausted } from "@better-ccflare/core";
import type { UsageData } from "../usage-fetcher";
import {
	getRankingUtilizationForProvider,
	getRepresentativeUsageResetMs,
	getRepresentativeUtilization,
	getRepresentativeUtilizationForProvider,
	getRepresentativeWindow,
} from "../usage-fetcher";

// The real shape of an account whose monthly overage credits are spent while
// its plan quota is nearly untouched: five_hour 5%, seven_day 1%, but
// extra_usage 100% (used_credits 1123 of a 1000 monthly_limit). Anthropic
// still serves these requests — it reports spend_limit_reached: false and the
// plan windows have headroom.
const overageSpent = {
	five_hour: { utilization: 5, resets_at: "2030-01-01T00:00:00.000Z" },
	seven_day: { utilization: 1, resets_at: "2030-01-07T00:00:00.000Z" },
	extra_usage: {
		is_enabled: true,
		monthly_limit: 1000,
		used_credits: 1123,
		utilization: 100,
		spend_limit_reached: false,
	},
} as unknown as UsageData;

describe("extra_usage is a billing pool, not a hard limit", () => {
	it("is excluded from the admission utilization", () => {
		expect(
			getRepresentativeUtilizationForProvider(overageSpent, "anthropic"),
		).toBe(5);
	});

	it("does not bench an account whose plan quota has headroom", () => {
		const utilization = getRepresentativeUtilizationForProvider(
			overageSpent,
			"anthropic",
		);
		const resetMs = getRepresentativeUsageResetMs(overageSpent, "anthropic");
		expect(isUsageExhausted(utilization, resetMs, Date.now())).toBe(false);
	});

	it("pairs the admission utilization with the reset of the same window", () => {
		// extra_usage has no resets_at; drawing the reset from it yields null,
		// which makes isUsageExhausted's staleness guard unclearable forever.
		expect(getRepresentativeUsageResetMs(overageSpent, "anthropic")).toBe(
			new Date("2030-01-01T00:00:00.000Z").getTime(),
		);
	});

	it("still benches an account whose real hard-limit window is exhausted", () => {
		const planExhausted = {
			five_hour: { utilization: 100, resets_at: "2030-01-01T00:00:00.000Z" },
			seven_day: { utilization: 20, resets_at: "2030-01-07T00:00:00.000Z" },
		} as unknown as UsageData;
		const utilization = getRepresentativeUtilizationForProvider(
			planExhausted,
			"anthropic",
		);
		expect(utilization).toBe(100);
		expect(
			isUsageExhausted(
				utilization,
				getRepresentativeUsageResetMs(planExhausted, "anthropic"),
				Date.now(),
			),
		).toBe(true);
	});

	it("still counts toward ranking, where less headroom should sort later", () => {
		expect(getRankingUtilizationForProvider(overageSpent, "anthropic")).toBe(
			100,
		);
	});

	it("remains visible on the display surfaces", () => {
		expect(getRepresentativeUtilization(overageSpent)).toBe(100);
		expect(getRepresentativeWindow(overageSpent)).toBe("extra_usage");
	});
});
