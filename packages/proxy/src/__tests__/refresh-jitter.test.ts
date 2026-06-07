import { describe, expect, it } from "bun:test";
import { AUTO_REFRESH_MAX_JITTER_MS } from "../constants";
import { computeRefreshScheduleDelay, sleepMs } from "../refresh-jitter";

describe("computeRefreshScheduleDelay", () => {
	it("returns a delay within [0, AUTO_REFRESH_MAX_JITTER_MS]", () => {
		for (let i = 0; i < 50; i++) {
			const delay = computeRefreshScheduleDelay("account-a");
			expect(delay).toBeGreaterThanOrEqual(0);
			expect(delay).toBeLessThanOrEqual(AUTO_REFRESH_MAX_JITTER_MS);
		}
	});

	it("spreads different account ids across the jitter range", () => {
		const delays = new Set(
			["acc-1", "acc-2", "acc-3", "acc-4", "acc-5"].map((id) =>
				Math.floor(computeRefreshScheduleDelay(id) / 1000),
			),
		);
		expect(delays.size).toBeGreaterThan(1);
	});

	it("respects a custom max jitter cap", () => {
		const delay = computeRefreshScheduleDelay("acc-x", 500);
		expect(delay).toBeGreaterThanOrEqual(0);
		expect(delay).toBeLessThanOrEqual(500);
	});
});

describe("sleepMs", () => {
	it("resolves immediately for zero or negative delay", async () => {
		const start = Date.now();
		await sleepMs(0);
		await sleepMs(-5);
		expect(Date.now() - start).toBeLessThan(50);
	});
});
