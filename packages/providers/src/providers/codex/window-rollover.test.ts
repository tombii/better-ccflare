import { describe, expect, it } from "bun:test";
import type { UsageData } from "../../usage-fetcher";
import {
	type CodexWindowSlot,
	codexWindowRolledOver,
	pickCodexRolloverSlot,
} from "./window-rollover";

const HOUR_MS = 60 * 60 * 1000;

function iso(offsetMs: number, now = Date.now()): string {
	return new Date(now + offsetMs).toISOString();
}

function usage(
	windows: Partial<
		Record<CodexWindowSlot, { utilization: number; resets_at: string | null }>
	>,
): UsageData {
	return windows as unknown as UsageData;
}

describe("pickCodexRolloverSlot", () => {
	it("picks five_hour when the payload reports a 5-hour reset", () => {
		expect(
			pickCodexRolloverSlot(
				usage({
					five_hour: { utilization: 10, resets_at: iso(HOUR_MS) },
					seven_day: { utilization: 40, resets_at: iso(50 * HOUR_MS) },
				}),
			),
		).toBe("five_hour");
	});

	it("falls back to seven_day for a weekly-only payload (Pro accounts)", () => {
		expect(
			pickCodexRolloverSlot(
				usage({ seven_day: { utilization: 40, resets_at: iso(50 * HOUR_MS) } }),
			),
		).toBe("seven_day");
	});

	it("stays on five_hour when pinned, even without a reported 5-hour window", () => {
		expect(
			pickCodexRolloverSlot(
				usage({ seven_day: { utilization: 40, resets_at: iso(50 * HOUR_MS) } }),
				true,
			),
		).toBe("five_hour");
	});

	it("falls back to seven_day when the 5-hour window has no reset", () => {
		expect(
			pickCodexRolloverSlot(
				usage({
					five_hour: { utilization: 10, resets_at: null },
					seven_day: { utilization: 40, resets_at: iso(50 * HOUR_MS) },
				}),
			),
		).toBe("seven_day");
	});

	it("handles a null/undefined payload", () => {
		expect(pickCodexRolloverSlot(null)).toBe("seven_day");
		expect(pickCodexRolloverSlot(undefined, true)).toBe("five_hour");
	});
});

describe("codexWindowRolledOver", () => {
	const now = Date.now();

	it("is false when a future sliding deadline advances", () => {
		// OpenAI slides the 5-hour resets_at forward while the account is idle.
		const prev = usage({
			five_hour: { utilization: 20, resets_at: iso(HOUR_MS, now) },
		});
		const next = usage({
			five_hour: { utilization: 25, resets_at: iso(2 * HOUR_MS, now) },
		});

		expect(codexWindowRolledOver(prev, next, now, "five_hour")).toBe(false);
	});

	it("is false when utilization keeps rising past the deadline", () => {
		const prev = usage({
			five_hour: { utilization: 20, resets_at: iso(-60_000, now) },
		});
		const next = usage({
			five_hour: { utilization: 25, resets_at: iso(5 * HOUR_MS, now) },
		});

		expect(codexWindowRolledOver(prev, next, now, "five_hour")).toBe(false);
	});

	it("is true when a passed deadline is followed by a utilization drop", () => {
		const prev = usage({
			five_hour: { utilization: 80, resets_at: iso(-60_000, now) },
		});
		const next = usage({
			five_hour: { utilization: 5, resets_at: iso(5 * HOUR_MS, now) },
		});

		expect(codexWindowRolledOver(prev, next, now, "five_hour")).toBe(true);
	});

	it("is true for the weekly slot on the same shape", () => {
		const prev = usage({
			seven_day: { utilization: 90, resets_at: iso(-60_000, now) },
		});
		const next = usage({
			seven_day: { utilization: 2, resets_at: iso(7 * 24 * HOUR_MS, now) },
		});

		expect(codexWindowRolledOver(prev, next, now, "seven_day")).toBe(true);
	});

	it("is false without a baseline", () => {
		const next = usage({
			five_hour: { utilization: 5, resets_at: iso(5 * HOUR_MS, now) },
		});

		expect(codexWindowRolledOver(null, next, now, "five_hour")).toBe(false);
		expect(codexWindowRolledOver(undefined, next, now, "five_hour")).toBe(
			false,
		);
	});

	it("is false when either side has no reset timestamp", () => {
		const withReset = usage({
			five_hour: { utilization: 80, resets_at: iso(-60_000, now) },
		});
		const withoutReset = usage({
			five_hour: { utilization: 5, resets_at: null },
		});

		expect(
			codexWindowRolledOver(withReset, withoutReset, now, "five_hour"),
		).toBe(false);
		expect(
			codexWindowRolledOver(withoutReset, withReset, now, "five_hour"),
		).toBe(false);
	});

	it("is false when the compared slot is absent from either side", () => {
		const prev = usage({
			five_hour: { utilization: 80, resets_at: iso(-60_000, now) },
		});
		const next = usage({
			seven_day: { utilization: 5, resets_at: iso(5 * HOUR_MS, now) },
		});

		expect(codexWindowRolledOver(prev, next, now, "five_hour")).toBe(false);
	});

	it("is false when the reset does not move", () => {
		const at = iso(-60_000, now);
		const prev = usage({ five_hour: { utilization: 80, resets_at: at } });
		const next = usage({ five_hour: { utilization: 5, resets_at: at } });

		expect(codexWindowRolledOver(prev, next, now, "five_hour")).toBe(false);
	});

	it("is false when an unparseable reset timestamp is involved", () => {
		const prev = usage({
			five_hour: { utilization: 80, resets_at: "nonsense" },
		});
		const next = usage({
			five_hour: { utilization: 5, resets_at: iso(5 * HOUR_MS, now) },
		});

		expect(codexWindowRolledOver(prev, next, now, "five_hour")).toBe(false);
	});
});
