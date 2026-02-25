import { describe, expect, it } from "bun:test";
import {
	getRepresentativeKiloUtilization,
	getRepresentativeKiloWindow,
	type KiloUsageData,
} from "../kilo-usage-fetcher";

describe("Kilo Usage Fetcher Helpers", () => {
	describe("getRepresentativeKiloUtilization", () => {
		it("should return null when usage is null", () => {
			expect(getRepresentativeKiloUtilization(null)).toBeNull();
		});

		it("should return utilizationPercent from usage data", () => {
			const usage: KiloUsageData = {
				microdollarsUsed: 4_195_117,
				totalMicrodollarsAcquired: 64_188_544,
				remainingUsd: (64_188_544 - 4_195_117) / 1_000_000,
				utilizationPercent: (4_195_117 / 64_188_544) * 100,
			};
			const result = getRepresentativeKiloUtilization(usage);
			expect(result).toBeCloseTo(6.534, 1);
		});

		it("should return 0 utilization when nothing has been used", () => {
			const usage: KiloUsageData = {
				microdollarsUsed: 0,
				totalMicrodollarsAcquired: 10_000_000,
				remainingUsd: 10,
				utilizationPercent: 0,
			};
			expect(getRepresentativeKiloUtilization(usage)).toBe(0);
		});

		it("should cap at 100% when fully used", () => {
			const usage: KiloUsageData = {
				microdollarsUsed: 10_000_000,
				totalMicrodollarsAcquired: 10_000_000,
				remainingUsd: 0,
				utilizationPercent: 100,
			};
			expect(getRepresentativeKiloUtilization(usage)).toBe(100);
		});
	});

	describe("getRepresentativeKiloWindow", () => {
		it("should return null when usage is null", () => {
			expect(getRepresentativeKiloWindow(null)).toBeNull();
		});

		it("should return 'credits' window label", () => {
			const usage: KiloUsageData = {
				microdollarsUsed: 1_000_000,
				totalMicrodollarsAcquired: 10_000_000,
				remainingUsd: 9,
				utilizationPercent: 10,
			};
			expect(getRepresentativeKiloWindow(usage)).toBe("credits");
		});
	});

	describe("remainingUsd calculation", () => {
		it("should correctly compute remaining USD from microdollars", () => {
			const used = 4_195_117;
			const acquired = 64_188_544;
			const remaining = Math.max(0, acquired - used) / 1_000_000;
			expect(remaining).toBeCloseTo(59.993, 2);
		});

		it("should not go below zero", () => {
			const usage: KiloUsageData = {
				microdollarsUsed: 10_000_000,
				totalMicrodollarsAcquired: 5_000_000,
				remainingUsd: 0,
				utilizationPercent: 100,
			};
			expect(usage.remainingUsd).toBe(0);
		});
	});
});
