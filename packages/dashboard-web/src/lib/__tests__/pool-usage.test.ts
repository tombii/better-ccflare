import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@better-ccflare/types";
import {
	computePoolUsage,
	isAlibabaShape,
	isAnthropicStyleShape,
	isNanoGPTShape,
	isZaiShape,
	normalizeResetMs,
} from "../pool-usage";

const NOW = 1_700_000_000_000;

function mkAccount(partial: Partial<AccountResponse>): AccountResponse {
	return {
		id: partial.id ?? "id",
		name: partial.name ?? "acc",
		provider: partial.provider ?? "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date(NOW).toISOString(),
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		autoPauseOnOverageEnabled: false,
		peakHoursPauseEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		crossRegionMode: null,
		modelFallbacks: null,
		billingType: null,
		sessionStats: null,
		...partial,
	};
}

describe("normalizeResetMs", () => {
	it("returns null for null/undefined", () => {
		expect(normalizeResetMs(null)).toBeNull();
		expect(normalizeResetMs(undefined)).toBeNull();
	});

	it("returns finite numbers as-is", () => {
		expect(normalizeResetMs(1_700_000_000_000)).toBe(1_700_000_000_000);
	});

	it("returns null for non-finite numbers", () => {
		expect(normalizeResetMs(Number.NaN)).toBeNull();
		expect(normalizeResetMs(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("parses ISO strings", () => {
		const iso = "2024-01-01T00:00:00.000Z";
		expect(normalizeResetMs(iso)).toBe(Date.parse(iso));
	});

	it("returns null for unparseable strings", () => {
		expect(normalizeResetMs("not-a-date")).toBeNull();
	});
});

describe("shape detectors", () => {
	it("isNanoGPTShape true for NanoGPT data", () => {
		expect(
			isNanoGPTShape({
				active: true,
				daily: { used: 0, remaining: 0, percentUsed: 0, resetAt: 0 },
				monthly: { used: 0, remaining: 0, percentUsed: 0, resetAt: 0 },
			} as never),
		).toBe(true);
	});

	it("isAlibabaShape true for Alibaba data", () => {
		expect(
			isAlibabaShape({
				five_hour: { percentUsed: 0, resetAt: 0 },
				weekly: { percentUsed: 0, resetAt: 0 },
			} as never),
		).toBe(true);
	});

	it("isZaiShape true when tokens_limit present", () => {
		expect(
			isZaiShape({
				tokens_limit: { percentage: 0, resetAt: 0 },
			} as never),
		).toBe(true);
	});

	it("isAnthropicStyleShape excludes alibaba/zai/nanogpt", () => {
		expect(
			isAnthropicStyleShape({
				five_hour: { utilization: 0, resets_at: null },
				seven_day: { utilization: 0, resets_at: null },
			} as never),
		).toBe(true);
		expect(
			isAnthropicStyleShape({
				five_hour: { percentUsed: 0, resetAt: 0 },
				weekly: { percentUsed: 0, resetAt: 0 },
			} as never),
		).toBe(false);
	});
});

describe("computePoolUsage", () => {
	it("returns empty for empty accounts", () => {
		const result = computePoolUsage([], "five_hour", NOW);
		expect(result.average).toBeNull();
		expect(result.worst).toBeNull();
		expect(result.contributing).toEqual([]);
		expect(result.excluded).toEqual([]);
		expect(result.fallback).toEqual([]);
		expect(result.earliestResetMs).toBeNull();
		expect(result.earliestResetAccountName).toBeNull();
	});

	it("averages Anthropic + Codex for 5h pool", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "anthro-a",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 40, resets_at: null },
					seven_day: { utilization: 20, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "codex-b",
				provider: "codex",
				usageData: {
					five_hour: { utilization: 60, resets_at: null },
					seven_day: { utilization: 30, resets_at: null },
				} as never,
			}),
		];

		const five = computePoolUsage(accounts, "five_hour", NOW);
		expect(five.average).toBe(50);
		expect(five.worst).toEqual({ name: "codex-b", pct: 60 });
		expect(five.contributing).toHaveLength(2);
		expect(five.excluded).toEqual([]);
		expect(five.fallback).toEqual([]);

		const seven = computePoolUsage(accounts, "seven_day", NOW);
		expect(seven.average).toBe(25);
		expect(seven.worst).toEqual({ name: "codex-b", pct: 30 });
	});

	it("Alibaba contributes to both pools via percentUsed", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "alibaba",
				provider: "alibaba-coding-plan",
				usageData: {
					five_hour: { percentUsed: 45, resetAt: NOW + 1_000_000 },
					weekly: { percentUsed: 70, resetAt: NOW + 2_000_000 },
					monthly: { percentUsed: 80, resetAt: NOW + 3_000_000 },
				} as never,
			}),
		];

		const five = computePoolUsage(accounts, "five_hour", NOW);
		expect(five.contributing).toHaveLength(1);
		expect(five.contributing[0].pct).toBe(45);
		expect(five.contributing[0].resetMs).toBe(NOW + 1_000_000);

		const seven = computePoolUsage(accounts, "seven_day", NOW);
		expect(seven.contributing).toHaveLength(1);
		expect(seven.contributing[0].pct).toBe(70);
		expect(seven.contributing[0].resetMs).toBe(NOW + 2_000_000);
	});

	it("Zai contributes to 5h via tokens_limit.percentage but is fallback for 7d", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "zai-1",
				provider: "zai",
				hasRefreshToken: false,
				usageData: {
					tokens_limit: { percentage: 33, resetAt: NOW + 1000 },
					time_limit: { percentage: 90, resetAt: NOW + 2000 },
				} as never,
			}),
		];

		const five = computePoolUsage(accounts, "five_hour", NOW);
		expect(five.contributing).toHaveLength(1);
		expect(five.contributing[0].pct).toBe(33);
		expect(five.fallback).toEqual([]);

		const seven = computePoolUsage(accounts, "seven_day", NOW);
		expect(seven.contributing).toEqual([]);
		expect(seven.fallback).toEqual([{ name: "zai-1", provider: "zai" }]);
	});

	it("claude-console-api goes to fallback for both pools", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "console",
				provider: "claude-console-api",
				hasRefreshToken: false,
				usageData: null,
			}),
		];

		const five = computePoolUsage(accounts, "five_hour", NOW);
		expect(five.fallback).toEqual([
			{ name: "console", provider: "claude-console-api" },
		]);
		expect(five.excluded).toEqual([]);
		expect(five.contributing).toEqual([]);

		const seven = computePoolUsage(accounts, "seven_day", NOW);
		expect(seven.fallback).toEqual([
			{ name: "console", provider: "claude-console-api" },
		]);
	});

	it("Anthropic with seven_day.utilization null: contributing to 5h, no_usage_data for 7d", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "anthro",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 25, resets_at: null },
					seven_day: { utilization: null, resets_at: null },
				} as never,
			}),
		];

		const five = computePoolUsage(accounts, "five_hour", NOW);
		expect(five.contributing).toHaveLength(1);
		expect(five.contributing[0].pct).toBe(25);

		const seven = computePoolUsage(accounts, "seven_day", NOW);
		expect(seven.contributing).toEqual([]);
		expect(seven.excluded).toEqual([
			{ name: "anthro", reason: "no_usage_data", resetMs: null },
		]);
	});

	it("paused account → excluded reason paused", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "p",
				provider: "anthropic",
				paused: true,
				usageData: {
					five_hour: { utilization: 50, resets_at: null },
					seven_day: { utilization: 50, resets_at: null },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.contributing).toEqual([]);
		expect(result.exhausted).toEqual([
			{ name: "p", reason: "paused", resetMs: null },
		]);
		expect(result.excluded).toEqual([]);
		expect(result.average).toBe(100);
	});

	it("rate_limited account (rateLimitedUntil > now) counts as exhausted capacity", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "active",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 20, resets_at: null },
					seven_day: { utilization: 20, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "rl",
				provider: "anthropic",
				rateLimitedUntil: NOW + 60_000,
				usageData: {
					five_hour: { utilization: 90, resets_at: null },
					seven_day: { utilization: 90, resets_at: null },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.average).toBe(60);
		expect(result.activeAverage).toBe(20);
		expect(result.contributing).toHaveLength(1);
		expect(result.exhausted).toEqual([
			{ name: "rl", reason: "rate_limited", resetMs: NOW + 60_000 },
		]);
		expect(result.excluded).toEqual([]);
	});

	it("token_expired requires hasRefreshToken=true and parsed time < now", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "te",
				provider: "anthropic",
				hasRefreshToken: true,
				tokenExpiresAt: new Date(NOW - 60_000).toISOString(),
				usageData: {
					five_hour: { utilization: 50, resets_at: null },
					seven_day: { utilization: 50, resets_at: null },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.exhausted).toEqual([
			{ name: "te", reason: "token_expired", resetMs: null },
		]);
		expect(result.excluded).toEqual([]);
		expect(result.average).toBe(100);
	});

	it("usage_rate_limited when usageRateLimitedUntil > now AND no usageData", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "url",
				provider: "anthropic",
				usageRateLimitedUntil: NOW + 60_000,
				usageData: null,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.exhausted).toEqual([
			{ name: "url", reason: "usage_rate_limited", resetMs: NOW + 60_000 },
		]);
		expect(result.excluded).toEqual([]);
		expect(result.average).toBe(100);
	});

	it("no_usage_data when eligible provider has usageData === null and is not rate-limited", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "nud",
				provider: "anthropic",
				usageData: null,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.excluded).toEqual([
			{ name: "nud", reason: "no_usage_data", resetMs: null },
		]);
	});

	it("API-key provider (hasRefreshToken=false) with tokenStatus=expired is NOT token_expired excluded", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "api-key",
				provider: "zai",
				hasRefreshToken: false,
				tokenStatus: "expired",
				tokenExpiresAt: new Date(NOW - 60_000).toISOString(),
				usageData: {
					tokens_limit: { percentage: 22, resetAt: NOW + 1000 },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.excluded).toEqual([]);
		expect(result.contributing).toHaveLength(1);
		expect(result.contributing[0].pct).toBe(22);
	});

	it("earliestResetMs filters nulls and picks min; earliestResetAccountName matches", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "a",
				provider: "anthropic",
				usageData: {
					five_hour: {
						utilization: 10,
						resets_at: new Date(NOW + 5_000_000).toISOString(),
					},
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "b",
				provider: "anthropic",
				usageData: {
					five_hour: {
						utilization: 20,
						resets_at: new Date(NOW + 1_000_000).toISOString(),
					},
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "c",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 30, resets_at: null },
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.earliestResetMs).toBe(NOW + 1_000_000);
		expect(result.earliestResetAccountName).toBe("b");
	});

	it("single contributing → returns worst (UI handles suppression)", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "solo",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 42, resets_at: null },
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.contributing).toHaveLength(1);
		expect(result.worst).toEqual({ name: "solo", pct: 42 });
	});

	it("Anthropic with seven_day_opus/seven_day_sonnet populated: only seven_day counts", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "anthro",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 10, resets_at: null },
					seven_day: { utilization: 50, resets_at: null },
					seven_day_opus: { utilization: 90, resets_at: null },
					seven_day_sonnet: { utilization: 99, resets_at: null },
					seven_day_oauth_apps: { utilization: 88, resets_at: null },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "seven_day", NOW);
		expect(result.contributing).toHaveLength(1);
		expect(result.contributing[0].pct).toBe(50);
		expect(result.average).toBe(50);
	});

	it("three contributing accounts 30/60/87 → average 59, worst points at 87% account", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "low",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 30, resets_at: null },
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "mid",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 60, resets_at: null },
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "high",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 87, resets_at: null },
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
		];

		const result = computePoolUsage(accounts, "five_hour", NOW);
		expect(result.average).toBe(59);
		expect(result.worst).toEqual({ name: "high", pct: 87 });
	});

	describe("atRisk projection", () => {
		const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
		const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

		function mkAnthropicAt(
			name: string,
			pct: number,
			resetMs: number | null,
		): AccountResponse {
			return mkAccount({
				name,
				provider: "anthropic",
				usageData: {
					five_hour: {
						utilization: pct,
						resets_at: resetMs == null ? null : new Date(resetMs).toISOString(),
					},
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			});
		}

		it("flags account burning faster than linear pace as at-risk", () => {
			// 4.5h elapsed of a 5h window, 90% used → time-to-exhaust 30m, remaining 30m
			// Use 91% to push timeToExhaust strictly below remaining.
			const elapsedMs = 4.5 * 60 * 60 * 1000;
			const resetMs = NOW + (FIVE_HOUR_MS - elapsedMs);
			const account = mkAnthropicAt("burner", 91, resetMs);

			const result = computePoolUsage([account], "five_hour", NOW);

			expect(result.atRisk).toHaveLength(1);
			expect(result.atRisk[0].name).toBe("burner");
			expect(result.atRisk[0].pct).toBe(91);
			expect(result.atRisk[0].resetMs).toBe(resetMs);
			expect(result.atRisk[0].remainingMs).toBe(FIVE_HOUR_MS - elapsedMs);
			expect(result.atRisk[0].exhaustsAtMs).toBeGreaterThan(NOW);
			expect(result.atRisk[0].exhaustsAtMs).toBeLessThan(resetMs);
		});

		it("does not flag account on linear pace boundary (timeToExhaust === remaining)", () => {
			// 1h elapsed of 5h window, 20% used → on perfect linear pace; will exactly
			// reach 100% at reset. timeToExhaustMs === remainingMs, not strictly less.
			const elapsedMs = 1 * 60 * 60 * 1000;
			const resetMs = NOW + (FIVE_HOUR_MS - elapsedMs);
			const account = mkAnthropicAt("steady", 20, resetMs);

			const result = computePoolUsage([account], "five_hour", NOW);

			expect(result.atRisk).toEqual([]);
		});

		it("does not flag account strictly under linear pace", () => {
			// 1h elapsed of 5h window, 10% used → timeToExhaust = 9h, remaining = 4h.
			// Far under pace; should never appear in atRisk.
			const elapsedMs = 1 * 60 * 60 * 1000;
			const resetMs = NOW + (FIVE_HOUR_MS - elapsedMs);
			const account = mkAnthropicAt("slow", 10, resetMs);

			const result = computePoolUsage([account], "five_hour", NOW);

			expect(result.contributing).toHaveLength(1);
			expect(result.atRisk).toEqual([]);
		});

		it("skips contributing accounts with resetMs === null", () => {
			const account = mkAnthropicAt("nullreset", 95, null);

			const result = computePoolUsage([account], "five_hour", NOW);

			expect(result.contributing).toHaveLength(1);
			expect(result.atRisk).toEqual([]);
		});

		it("skips contributing accounts with 0% usage (no rate to project)", () => {
			const elapsedMs = 1 * 60 * 60 * 1000;
			const resetMs = NOW + (FIVE_HOUR_MS - elapsedMs);
			const account = mkAnthropicAt("idle", 0, resetMs);

			const result = computePoolUsage([account], "five_hour", NOW);

			expect(result.atRisk).toEqual([]);
		});

		it("does not include exhausted accounts in atRisk (they are already in exhausted)", () => {
			const elapsedMs = 4.5 * 60 * 60 * 1000;
			const resetMs = NOW + (FIVE_HOUR_MS - elapsedMs);
			const burner = mkAnthropicAt("burner", 95, resetMs);
			const exhaustedAccount = mkAccount({
				name: "exh",
				provider: "anthropic",
				usageData: {
					five_hour: {
						utilization: 100,
						resets_at: new Date(NOW + 60_000).toISOString(),
					},
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			});

			const result = computePoolUsage(
				[burner, exhaustedAccount],
				"five_hour",
				NOW,
			);

			expect(result.atRisk).toHaveLength(1);
			expect(result.atRisk[0].name).toBe("burner");
			expect(result.exhausted.map((e) => e.name)).toContain("exh");
		});

		it("projects 7d window correctly using SEVEN_DAY_MS", () => {
			// 6 days elapsed of 7d window, 95% used → timeToExhaust ≈ 6d * 0.05/0.95 ≈ 7.6h
			// remaining = 24h, so 7.6h < 24h → at risk.
			const elapsedMs = 6 * 24 * 60 * 60 * 1000;
			const resetMs = NOW + (SEVEN_DAY_MS - elapsedMs);
			const account = mkAccount({
				name: "weekly-burner",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 0, resets_at: null },
					seven_day: {
						utilization: 95,
						resets_at: new Date(resetMs).toISOString(),
					},
				} as never,
			});

			const result = computePoolUsage([account], "seven_day", NOW);

			expect(result.atRisk).toHaveLength(1);
			expect(result.atRisk[0].name).toBe("weekly-burner");
			expect(result.atRisk[0].resetMs).toBe(resetMs);
		});
	});

	it("counts accounts exhausted in another quota window as unavailable 5h capacity", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "codex",
				provider: "codex",
				usageData: {
					five_hour: { utilization: 28, resets_at: null },
					seven_day: { utilization: 35, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "weekly-exhausted",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 31, resets_at: null },
					seven_day: {
						utilization: 100,
						resets_at: new Date(NOW + 5_000_000).toISOString(),
					},
				} as never,
			}),
			mkAccount({
				name: "five-hour-exhausted",
				provider: "anthropic",
				usageData: {
					five_hour: {
						utilization: 100,
						resets_at: new Date(NOW + 1_000_000).toISOString(),
					},
					seven_day: { utilization: 30, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "both-exhausted",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 0, resets_at: null },
					seven_day: { utilization: 100, resets_at: null },
				} as never,
			}),
		];

		const fiveHour = computePoolUsage(accounts, "five_hour", NOW);
		expect(fiveHour.average).toBe(82);
		expect(fiveHour.activeAverage).toBe(28);
		expect(fiveHour.contributing).toEqual([
			{ name: "codex", pct: 28, resetMs: null },
		]);
		expect(fiveHour.exhausted).toEqual([
			{
				name: "weekly-exhausted",
				reason: "seven_day_exhausted",
				resetMs: NOW + 5_000_000,
			},
			{
				name: "five-hour-exhausted",
				reason: "five_hour_exhausted",
				resetMs: NOW + 1_000_000,
			},
			{ name: "both-exhausted", reason: "seven_day_exhausted", resetMs: null },
		]);
		expect(fiveHour.earliestResetMs).toBe(NOW + 1_000_000);
		expect(fiveHour.earliestResetAccountName).toBe("five-hour-exhausted");

		const sevenDay = computePoolUsage(accounts, "seven_day", NOW);
		expect(sevenDay.average).toBe(83.75);
		expect(sevenDay.activeAverage).toBe(35);
		expect(sevenDay.contributing).toEqual([
			{ name: "codex", pct: 35, resetMs: null },
		]);
		expect(sevenDay.exhausted).toEqual([
			{
				name: "weekly-exhausted",
				reason: "seven_day_exhausted",
				resetMs: NOW + 5_000_000,
			},
			{
				name: "five-hour-exhausted",
				reason: "five_hour_exhausted",
				resetMs: NOW + 1_000_000,
			},
			{ name: "both-exhausted", reason: "seven_day_exhausted", resetMs: null },
		]);
		expect(sevenDay.earliestResetMs).toBe(NOW + 1_000_000);
		expect(sevenDay.earliestResetAccountName).toBe("five-hour-exhausted");
	});
});
