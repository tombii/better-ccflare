import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@better-ccflare/types";
import type { RoutingObservation } from "../../api";
import {
	buildPoolSegments,
	computePoolUsage,
	computeScopedPoolUsage,
	formatFamilyLabel,
	formatRelativeReset,
	isAlibabaShape,
	isAnthropicStyleShape,
	isNanoGPTShape,
	isZaiShape,
	listObservedFamilies,
	normalizeResetMs,
	type PoolUsageResult,
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

	it("Codex with an unknown five_hour is excluded, not averaged in as 0%", () => {
		// The accounts handler now reports an unreported window as null instead of
		// minting a 0%. A false 0 used to count as an idle contributing account and
		// drag the 5h tile's average down.
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "anthro",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 80, resets_at: null },
					seven_day: { utilization: 40, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "codex",
				provider: "codex",
				usageData: {
					five_hour: { utilization: null, resets_at: null },
					seven_day: { utilization: 63, resets_at: null },
				} as never,
			}),
		];

		const five = computePoolUsage(accounts, "five_hour", NOW);
		expect(five.average).toBe(80);
		expect(five.contributing).toHaveLength(1);
		expect(five.contributing[0].name).toBe("anthro");
		expect(five.excluded).toEqual([
			{ name: "codex", reason: "no_usage_data", resetMs: null },
		]);

		// The weekly pool still counts it — that window is the one Codex reports.
		const seven = computePoolUsage(accounts, "seven_day", NOW);
		expect(seven.contributing).toHaveLength(2);
		expect(seven.average).toBe(51.5);
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

describe("Anthropic limits[] primary (pool usage)", () => {
	const RESET_ISO = "2030-01-01T00:00:00.000Z";

	it("isAnthropicStyleShape is true for a limits[]-only payload", () => {
		expect(
			isAnthropicStyleShape({
				limits: [{ kind: "session", percent: 10, resets_at: RESET_ISO }],
			} as never),
		).toBe(true);
	});

	it("reads five_hour / seven_day from limits[] when no flat windows exist", () => {
		const acc = mkAccount({
			provider: "anthropic",
			usageData: {
				limits: [
					{ kind: "session", percent: 40, resets_at: RESET_ISO, scope: null },
					{
						kind: "weekly_all",
						percent: 70,
						resets_at: RESET_ISO,
						scope: null,
					},
				],
			} as never,
		});
		const five = computePoolUsage([acc], "five_hour", NOW);
		expect(five.contributing[0]?.pct).toBe(40);
		const seven = computePoolUsage([acc], "seven_day", NOW);
		expect(seven.contributing[0]?.pct).toBe(70);
	});

	it("classifies a weekly_all >= 100 from limits[] as seven_day_exhausted", () => {
		const acc = mkAccount({
			name: "fable-capped",
			provider: "anthropic",
			usageData: {
				limits: [
					{ kind: "session", percent: 10, resets_at: RESET_ISO, scope: null },
					{
						kind: "weekly_all",
						percent: 100,
						resets_at: RESET_ISO,
						scope: null,
					},
				],
			} as never,
		});
		const seven = computePoolUsage([acc], "seven_day", NOW);
		expect(seven.exhausted.map((e) => e.reason)).toContain(
			"seven_day_exhausted",
		);
	});

	it("falls back to the flat window when the matching kind is absent from limits[]", () => {
		const acc = mkAccount({
			provider: "anthropic",
			usageData: {
				// limits[] has only a session entry; seven_day must come from the flat window.
				limits: [
					{ kind: "session", percent: 20, resets_at: RESET_ISO, scope: null },
				],
				seven_day: { utilization: 55, resets_at: RESET_ISO },
			} as never,
		});
		const seven = computePoolUsage([acc], "seven_day", NOW);
		expect(seven.contributing[0]?.pct).toBe(55);
	});

	it("falls back to the flat window when the limits[] entry exists but percent is null", () => {
		const acc = mkAccount({
			provider: "anthropic",
			usageData: {
				// session limit present but percent null -> must NOT shadow the flat window.
				limits: [
					{ kind: "session", percent: null, resets_at: RESET_ISO, scope: null },
				],
				five_hour: { utilization: 33, resets_at: RESET_ISO },
			} as never,
		});
		const five = computePoolUsage([acc], "five_hour", NOW);
		expect(five.contributing[0]?.pct).toBe(33);
	});
});

describe("computeScopedPoolUsage", () => {
	const RESET_ISO = "2030-01-01T00:00:00.000Z";
	const RESET_MS = Date.parse(RESET_ISO);

	function mkScopedAccount(
		name: string,
		family: string,
		percent: number | null,
		extra?: Partial<AccountResponse>,
	): AccountResponse {
		return mkAccount({
			name,
			provider: "anthropic",
			usageData: {
				limits: [
					{
						kind: "weekly_scoped",
						percent,
						resets_at: RESET_ISO,
						scope: { model: { id: null, display_name: family }, surface: null },
					},
				],
			} as never,
			...extra,
		});
	}

	it("returns [] when no account has any weekly_scoped limits", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "plain",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 10, resets_at: null },
					seven_day: { utilization: 10, resets_at: null },
				} as never,
			}),
		];
		expect(computeScopedPoolUsage(accounts, NOW)).toEqual([]);
	});

	it("matches accounts whose display_name carries surrounding whitespace", () => {
		// discoverScopedFamilies trims the name ("Fable " -> family "Fable"), so
		// extractWeeklyScoped must trim too or the padded account silently drops
		// out of the very pool its entry created.
		const accounts: AccountResponse[] = [
			mkScopedAccount("padded", "Fable ", 40),
			mkScopedAccount("clean", "Fable", 60),
		];
		const pools = computeScopedPoolUsage(accounts, NOW);
		expect(pools).toHaveLength(1);
		expect(pools[0].family).toBe("Fable");
		expect(pools[0].result.contributing.map((c) => c.name).sort()).toEqual([
			"clean",
			"padded",
		]);
	});

	it("discovers the family from the data and aggregates that family's pool", () => {
		const accounts: AccountResponse[] = [
			mkScopedAccount("a", "Fable", 20),
			mkScopedAccount("b", "Fable", 40),
		];
		const pools = computeScopedPoolUsage(accounts, NOW);
		expect(pools).toHaveLength(1);
		expect(pools[0].family).toBe("Fable");
		expect(pools[0].result.contributing).toHaveLength(2);
		expect(pools[0].result.average).toBe(30);
	});

	it("discovers multiple families in stable alphabetical order", () => {
		const accounts: AccountResponse[] = [
			mkScopedAccount("a", "Sonnet", 10),
			mkScopedAccount("b", "Fable", 20),
		];
		const pools = computeScopedPoolUsage(accounts, NOW);
		expect(pools.map((p) => p.family)).toEqual(["Fable", "Sonnet"]);
	});

	it("average includes scoped-exhausted (>=100%) accounts as 100, activeAverage excludes them", () => {
		const accounts: AccountResponse[] = [
			mkScopedAccount("low", "Fable", 20),
			mkScopedAccount("maxed", "Fable", 100),
		];
		const pool = computeScopedPoolUsage(accounts, NOW)[0].result;
		expect(pool.average).toBe(60);
		expect(pool.activeAverage).toBe(20);
	});

	it("scoped percent >= 100 is classified as family_exhausted", () => {
		const accounts: AccountResponse[] = [
			mkScopedAccount("maxed", "Fable", 100),
		];
		const pool = computeScopedPoolUsage(accounts, NOW)[0].result;
		expect(pool.exhausted).toEqual([
			{ name: "maxed", reason: "family_exhausted", resetMs: RESET_MS },
		]);
	});

	it("account 5h-exhausted (flat window) is disqualified in the family pool too", () => {
		const account = mkScopedAccount("acc", "Fable", 10, {
			usageData: {
				five_hour: {
					utilization: 100,
					resets_at: new Date(NOW + 1_000_000).toISOString(),
				},
				seven_day: { utilization: 0, resets_at: null },
				limits: [
					{
						kind: "weekly_scoped",
						percent: 10,
						resets_at: RESET_ISO,
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: null,
						},
					},
				],
			} as never,
		});
		const pool = computeScopedPoolUsage([account], NOW)[0].result;
		expect(pool.contributing).toEqual([]);
		expect(pool.exhausted).toEqual([
			{ name: "acc", reason: "five_hour_exhausted", resetMs: NOW + 1_000_000 },
		]);
	});

	it("entry present but percent null -> excluded no_usage_data", () => {
		const account = mkScopedAccount("nulled", "Fable", null);
		const pool = computeScopedPoolUsage([account], NOW)[0].result;
		expect(pool.excluded).toEqual([
			{ name: "nulled", reason: "no_usage_data", resetMs: RESET_MS },
		]);
	});

	it("accounts without a scoped entry for the family are omitted, not fallback", () => {
		const accounts: AccountResponse[] = [
			mkScopedAccount("member", "Fable", 20),
			mkAccount({
				name: "outsider",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 10, resets_at: null },
					seven_day: { utilization: 10, resets_at: null },
				} as never,
			}),
		];
		const pool = computeScopedPoolUsage(accounts, NOW)[0].result;
		expect(pool.contributing).toHaveLength(1);
		expect(pool.fallback).toEqual([]);
		expect(pool.excluded).toEqual([]);
	});

	it("projects atRisk using the seven_day window", () => {
		const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
		const elapsedMs = 6 * 24 * 60 * 60 * 1000;
		const resetMs = NOW + (SEVEN_DAY_MS - elapsedMs);
		const account = mkScopedAccount("burner", "Fable", 95, {
			usageData: {
				limits: [
					{
						kind: "weekly_scoped",
						percent: 95,
						resets_at: new Date(resetMs).toISOString(),
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: null,
						},
					},
				],
			} as never,
		});
		const pool = computeScopedPoolUsage([account], NOW)[0].result;
		expect(pool.atRisk).toHaveLength(1);
		expect(pool.atRisk[0].name).toBe("burner");
	});
});

describe("buildPoolSegments", () => {
	function mkResult(partial: Partial<PoolUsageResult>): PoolUsageResult {
		return {
			average: null,
			activeAverage: null,
			worst: null,
			contributing: [],
			exhausted: [],
			excluded: [],
			fallback: [],
			earliestResetMs: null,
			earliestResetAccountName: null,
			atRisk: [],
			...partial,
		};
	}

	it("maps contributing accounts to active segments with their own pct", () => {
		const result = mkResult({
			contributing: [
				{ name: "a", pct: 42, resetMs: null },
				{ name: "b", pct: 10, resetMs: null },
			],
		});
		const segments = buildPoolSegments(result);
		expect(segments).toHaveLength(2);
		expect(segments.every((s) => s.kind === "active")).toBe(true);
		expect(segments.find((s) => s.name === "a")?.pct).toBe(42);
		expect(segments.find((s) => s.name === "b")?.pct).toBe(10);
	});

	it("maps exhausted accounts to pct=100, kind exhausted, carrying their reason", () => {
		const result = mkResult({
			exhausted: [{ name: "x", reason: "five_hour_exhausted", resetMs: null }],
		});
		const segments = buildPoolSegments(result);
		expect(segments).toEqual([
			{
				name: "x",
				pct: 100,
				kind: "exhausted",
				reason: "five_hour_exhausted",
				resetMs: null,
			},
		]);
	});

	it("maps excluded accounts to pct=null, kind unknown, carrying their reason", () => {
		const result = mkResult({
			excluded: [{ name: "u", reason: "no_usage_data", resetMs: null }],
		});
		const segments = buildPoolSegments(result);
		expect(segments).toEqual([
			{
				name: "u",
				pct: null,
				kind: "unknown",
				reason: "no_usage_data",
				resetMs: null,
			},
		]);
	});

	it("carries resetMs through from contributing/exhausted/excluded entries", () => {
		const result = mkResult({
			contributing: [{ name: "a", pct: 42, resetMs: NOW + 1000 }],
			exhausted: [
				{ name: "x", reason: "five_hour_exhausted", resetMs: NOW + 2000 },
			],
			excluded: [{ name: "u", reason: "no_usage_data", resetMs: NOW + 3000 }],
		});
		const segments = buildPoolSegments(result);
		expect(segments.find((s) => s.name === "a")?.resetMs).toBe(NOW + 1000);
		expect(segments.find((s) => s.name === "x")?.resetMs).toBe(NOW + 2000);
		expect(segments.find((s) => s.name === "u")?.resetMs).toBe(NOW + 3000);
	});

	it("resetMs is null on a segment when the source entry's resetMs is null", () => {
		const result = mkResult({
			contributing: [{ name: "a", pct: 42, resetMs: null }],
		});
		const segments = buildPoolSegments(result);
		expect(segments[0].resetMs).toBeNull();
	});

	it("omits fallback accounts entirely", () => {
		const result = mkResult({
			contributing: [{ name: "a", pct: 50, resetMs: null }],
			fallback: [{ name: "f", provider: "claude-console-api" }],
		});
		const segments = buildPoolSegments(result);
		expect(segments.map((s) => s.name)).toEqual(["a"]);
	});

	it("sorts descending by pct, with null (unknown) always last", () => {
		const result = mkResult({
			contributing: [
				{ name: "mid", pct: 50, resetMs: null },
				{ name: "high", pct: 90, resetMs: null },
			],
			exhausted: [
				{ name: "maxed", reason: "seven_day_exhausted", resetMs: null },
			],
			excluded: [{ name: "unk", reason: "no_usage_data", resetMs: null }],
		});
		const segments = buildPoolSegments(result);
		expect(segments.map((s) => s.name)).toEqual([
			"maxed",
			"high",
			"mid",
			"unk",
		]);
	});

	it("breaks ties at equal pct alphabetically by name (deterministic)", () => {
		const result = mkResult({
			contributing: [
				{ name: "zeta", pct: 50, resetMs: null },
				{ name: "alpha", pct: 50, resetMs: null },
				{ name: "mike", pct: 50, resetMs: null },
			],
		});
		const segments = buildPoolSegments(result);
		expect(segments.map((s) => s.name)).toEqual(["alpha", "mike", "zeta"]);
	});

	it("breaks ties among multiple null (unknown) segments alphabetically by name", () => {
		const result = mkResult({
			excluded: [
				{ name: "zeta", reason: "no_usage_data", resetMs: null },
				{ name: "alpha", reason: "no_usage_data", resetMs: null },
			],
		});
		const segments = buildPoolSegments(result);
		expect(segments.map((s) => s.name)).toEqual(["alpha", "zeta"]);
	});

	it("orders segments: exhausted (alphabetical) -> at-risk (ascending exhaustsAtMs) -> rest (descending pct)", () => {
		const result = mkResult({
			contributing: [
				{ name: "risk-later", pct: 40, resetMs: null },
				{ name: "risk-soon", pct: 70, resetMs: null },
				{ name: "safe-high", pct: 90, resetMs: null },
				{ name: "safe-low", pct: 10, resetMs: null },
			],
			exhausted: [
				{ name: "zzz-exhausted", reason: "five_hour_exhausted", resetMs: null },
				{ name: "aaa-exhausted", reason: "five_hour_exhausted", resetMs: null },
			],
			atRisk: [
				{
					name: "risk-soon",
					pct: 70,
					resetMs: NOW + 1000,
					exhaustsAtMs: NOW + 500,
					timeToExhaustMs: 500,
					remainingMs: 1000,
				},
				{
					name: "risk-later",
					pct: 40,
					resetMs: NOW + 1000,
					exhaustsAtMs: NOW + 900,
					timeToExhaustMs: 900,
					remainingMs: 1000,
				},
			],
		});
		const segments = buildPoolSegments(result);
		expect(segments.map((s) => s.name)).toEqual([
			"aaa-exhausted",
			"zzz-exhausted",
			"risk-soon",
			"risk-later",
			"safe-high",
			"safe-low",
		]);
	});

	it("breaks ties within the at-risk group alphabetically when exhaustsAtMs is equal", () => {
		const result = mkResult({
			contributing: [
				{ name: "zed", pct: 50, resetMs: null },
				{ name: "alpha", pct: 50, resetMs: null },
			],
			atRisk: [
				{
					name: "zed",
					pct: 50,
					resetMs: NOW + 1000,
					exhaustsAtMs: NOW + 500,
					timeToExhaustMs: 500,
					remainingMs: 1000,
				},
				{
					name: "alpha",
					pct: 50,
					resetMs: NOW + 1000,
					exhaustsAtMs: NOW + 500,
					timeToExhaustMs: 500,
					remainingMs: 1000,
				},
			],
		});
		const segments = buildPoolSegments(result);
		expect(segments.map((s) => s.name)).toEqual(["alpha", "zed"]);
	});

	it("copies exhaustsAtMs from the matching atRisk entry onto its segment", () => {
		const result = mkResult({
			contributing: [{ name: "a", pct: 70, resetMs: null }],
			atRisk: [
				{
					name: "a",
					pct: 70,
					resetMs: NOW + 1000,
					exhaustsAtMs: NOW + 500,
					timeToExhaustMs: 500,
					remainingMs: 1000,
				},
			],
		});
		const segments = buildPoolSegments(result);
		expect(segments).toHaveLength(1);
		expect(segments[0].exhaustsAtMs).toBe(NOW + 500);
	});

	it("leaves exhaustsAtMs undefined for a contributing segment with no atRisk entry", () => {
		const result = mkResult({
			contributing: [{ name: "a", pct: 70, resetMs: null }],
		});
		const segments = buildPoolSegments(result);
		expect(segments).toHaveLength(1);
		expect(segments[0].exhaustsAtMs).toBeUndefined();
	});

	it("never assigns exhaustsAtMs to an exhausted segment even if its name matches an atRisk entry", () => {
		// atRisk is only ever built from contributing accounts (finalizePoolResult),
		// so this should not happen in practice, but the segment mapping must not
		// accidentally pick it up via a shared name if it ever did.
		const result = mkResult({
			exhausted: [{ name: "a", reason: "five_hour_exhausted", resetMs: null }],
			atRisk: [
				{
					name: "a",
					pct: 100,
					resetMs: NOW + 1000,
					exhaustsAtMs: NOW + 500,
					timeToExhaustMs: 500,
					remainingMs: 1000,
				},
			],
		});
		const segments = buildPoolSegments(result);
		expect(segments).toHaveLength(1);
		expect(segments[0].exhaustsAtMs).toBeUndefined();
	});

	it("invariant: the average of non-unknown segments equals result.average", () => {
		const accounts: AccountResponse[] = [
			mkAccount({
				name: "a",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 30, resets_at: null },
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "b",
				provider: "anthropic",
				usageData: {
					five_hour: { utilization: 90, resets_at: null },
					seven_day: { utilization: 0, resets_at: null },
				} as never,
			}),
			mkAccount({
				name: "c",
				provider: "anthropic",
				paused: true,
			}),
			mkAccount({
				name: "d",
				provider: "anthropic",
				usageData: null,
			}),
		];
		const result = computePoolUsage(accounts, "five_hour", NOW);
		const segments = buildPoolSegments(result);
		const counted = segments.filter((s) => s.kind !== "unknown");
		expect(counted.length).toBeGreaterThan(0);
		const avg =
			counted.reduce((sum, s) => sum + (s.pct ?? 0), 0) / counted.length;
		expect(avg).toBeCloseTo(result.average as number, 10);
	});

	it("empty result produces no segments", () => {
		expect(buildPoolSegments(mkResult({}))).toEqual([]);
	});
});

describe("formatRelativeReset", () => {
	it("returns null when resetMs is null", () => {
		expect(formatRelativeReset(null, NOW)).toBeNull();
	});

	it("returns null when resetMs is in the past", () => {
		expect(formatRelativeReset(NOW - 1000, NOW)).toBeNull();
	});

	it("returns null when resetMs equals now (not strictly future)", () => {
		expect(formatRelativeReset(NOW, NOW)).toBeNull();
	});

	it("formats under an hour as minutes only (boundary: 59m)", () => {
		expect(formatRelativeReset(NOW + 59 * 60 * 1000, NOW)).toBe("in 59m");
	});

	it("formats just over an hour as hours + minutes (boundary: 61m)", () => {
		expect(formatRelativeReset(NOW + 61 * 60 * 1000, NOW)).toBe("in 1h 1m");
	});

	it("formats just under a day as hours + minutes (boundary: 23h)", () => {
		expect(formatRelativeReset(NOW + 23 * 60 * 60 * 1000, NOW)).toBe(
			"in 23h 0m",
		);
	});

	it("formats a day or more as days + hours (boundary: 25h)", () => {
		expect(formatRelativeReset(NOW + 25 * 60 * 60 * 1000, NOW)).toBe(
			"in 1d 1h",
		);
	});

	it("formats exactly 1 day as days + hours (boundary: 24h)", () => {
		expect(formatRelativeReset(NOW + 24 * 60 * 60 * 1000, NOW)).toBe(
			"in 1d 0h",
		);
	});

	it("formats multiple days", () => {
		expect(formatRelativeReset(NOW + (2 * 24 + 4) * 60 * 60 * 1000, NOW)).toBe(
			"in 2d 4h",
		);
	});

	it("formats exactly 1 minute", () => {
		expect(formatRelativeReset(NOW + 60 * 1000, NOW)).toBe("in 1m");
	});
});

describe("listObservedFamilies", () => {
	function mkObservation(family: string): RoutingObservation {
		return {
			family,
			order: [{ id: "1", name: "acc-a" }],
			model: `claude-${family}`,
			observedAtMs: NOW,
		};
	}

	it("returns [] for undefined, null, and empty observations", () => {
		expect(listObservedFamilies(undefined)).toEqual([]);
		expect(listObservedFamilies(null)).toEqual([]);
		expect(listObservedFamilies({})).toEqual([]);
	});

	it("returns every family, sorted alphabetically by family key", () => {
		const observations = {
			sonnet: mkObservation("sonnet"),
			opus: mkObservation("opus"),
			fable: mkObservation("fable"),
		};
		const result = listObservedFamilies(observations);
		expect(result.map((r) => r.family)).toEqual(["fable", "opus", "sonnet"]);
		expect(result[0].observation).toEqual(observations.fable);
		expect(result[1].observation).toEqual(observations.opus);
		expect(result[2].observation).toEqual(observations.sonnet);
	});

	it("includes a family that also has its own pool row (e.g. fable)", () => {
		const observations = { fable: mkObservation("fable") };
		expect(listObservedFamilies(observations)).toEqual([
			{ family: "fable", observation: observations.fable },
		]);
	});
});

describe("formatFamilyLabel", () => {
	it("capitalizes a lowercase family name", () => {
		expect(formatFamilyLabel("fable")).toBe("Fable");
		expect(formatFamilyLabel("opus")).toBe("Opus");
	});

	it("leaves an already-capitalized family name unchanged", () => {
		expect(formatFamilyLabel("Fable")).toBe("Fable");
	});

	it("returns an empty string for an empty family name", () => {
		expect(formatFamilyLabel("")).toBe("");
	});

	it("trims surrounding whitespace before capitalizing", () => {
		expect(formatFamilyLabel("  fable  ")).toBe("Fable");
	});

	it("leaves the remainder of the string unchanged (no lowercasing)", () => {
		expect(formatFamilyLabel("fABLE")).toBe("FABLE");
	});
});
