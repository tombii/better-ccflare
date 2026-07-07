import { describe, expect, it } from "bun:test";
import type { UsageData } from "../usage-fetcher";
import {
	getRepresentativeUtilization,
	getRepresentativeUtilizationForProvider,
	getRepresentativeWindow,
} from "../usage-fetcher";

const R = "2030-01-01T00:00:00.000Z";

// A limits[]-only Anthropic payload (no flat five_hour/seven_day) — the shape
// Anthropic moves toward. The account-level number must come from limits[]:
// weekly_all 70 is the hard account cap; the Fable 100% weekly_scoped is a
// per-model cap and must NOT count as the account-level utilization.
const limitsOnly = {
	limits: [
		{ kind: "session", percent: 40, resets_at: R, scope: null },
		{ kind: "weekly_all", percent: 70, resets_at: R, scope: null },
		{
			kind: "weekly_scoped",
			percent: 100,
			resets_at: R,
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		},
	],
} as unknown as UsageData;

describe("getRepresentativeUtilization — limits[] (P1)", () => {
	it("reads account-level session/weekly_all from limits[], ignoring weekly_scoped", () => {
		expect(getRepresentativeUtilization(limitsOnly)).toBe(70);
	});

	it("returns null (not 0) when no usable window is present", () => {
		expect(
			getRepresentativeUtilization({ limits: [] } as unknown as UsageData),
		).toBeNull();
	});

	it("still reads legacy flat windows when limits[] is absent", () => {
		const flat = {
			five_hour: { utilization: 30, resets_at: R },
			seven_day: { utilization: 20, resets_at: R },
		} as UsageData;
		expect(getRepresentativeUtilization(flat)).toBe(30);
	});
});

describe("getRepresentativeWindow — limits[] (P1)", () => {
	it("maps the most-restrictive account-level limit to a canonical window key", () => {
		// weekly_all (70) beats session (40) -> canonical "seven_day".
		expect(getRepresentativeWindow(limitsOnly)).toBe("seven_day");
	});
});

describe("getRepresentativeUtilizationForProvider — limits[] (P1)", () => {
	it("anthropic reads account-level limits[] (max session/weekly_all)", () => {
		expect(
			getRepresentativeUtilizationForProvider(limitsOnly, "anthropic"),
		).toBe(70);
	});
});
