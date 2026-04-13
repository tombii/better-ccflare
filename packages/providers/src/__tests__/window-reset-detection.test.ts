import { describe, expect, it, mock } from "bun:test";
import { extractWindowResetTime, usageCache } from "../usage-fetcher";
import type { ZaiUsageData } from "../zai-usage-fetcher";
import type { UsageData } from "../usage-fetcher";

// ── extractWindowResetTime ────────────────────────────────────────────────────

describe("extractWindowResetTime", () => {
	it("returns tokens_limit.resetAt for zai provider", () => {
		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: { used: 10, remaining: 90, percentage: 10, resetAt: 9999000, type: "tokens_limit" },
		};
		expect(extractWindowResetTime(data, "zai")).toBe(9999000);
	});

	it("returns null for zai provider when tokens_limit is null", () => {
		const data: ZaiUsageData = { time_limit: null, tokens_limit: null };
		expect(extractWindowResetTime(data, "zai")).toBeNull();
	});

	it("returns parsed resets_at ms for anthropic provider", () => {
		const resetIso = "2030-01-01T12:00:00Z";
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: resetIso },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBe(new Date(resetIso).getTime());
	});

	it("returns null for anthropic when resets_at is null", () => {
		const data: UsageData = {
			five_hour: { utilization: 50, resets_at: null },
			seven_day: { utilization: 10, resets_at: null },
		};
		expect(extractWindowResetTime(data, "anthropic")).toBeNull();
	});

	it("returns null for unknown/unsupported provider", () => {
		expect(extractWindowResetTime({} as any, "nanogpt")).toBeNull();
	});
});

// ── onWindowReset callback via usageCache.set ─────────────────────────────────

describe("usageCache window-reset callback", () => {
	it("fires onWindowReset when zai resetAt advances to a later value", () => {
		const accountId = "zai-window-reset-test";
		const callback = mock(() => {});

		const oldData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: { used: 80, remaining: 20, percentage: 80, resetAt: 1000000, type: "tokens_limit" },
		};
		const newData: ZaiUsageData = {
			time_limit: null,
			tokens_limit: { used: 2, remaining: 98, percentage: 2, resetAt: 2000000, type: "tokens_limit" },
		};

		// Seed the cache with old data, then simulate a poll delivering new data
		usageCache.set(accountId, oldData);
		usageCache.notifyWindowReset(accountId, newData, "zai", callback);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(accountId);

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset when resetAt stays the same", () => {
		const accountId = "zai-no-reset-test";
		const callback = mock(() => {});

		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: { used: 50, remaining: 50, percentage: 50, resetAt: 1000000, type: "tokens_limit" },
		};

		usageCache.set(accountId, data);
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();

		usageCache.delete(accountId);
	});

	it("does not fire onWindowReset on the first poll (no previous data)", () => {
		const accountId = "zai-first-poll-test";
		const callback = mock(() => {});

		const data: ZaiUsageData = {
			time_limit: null,
			tokens_limit: { used: 5, remaining: 95, percentage: 5, resetAt: 3000000, type: "tokens_limit" },
		};

		// No prior set() — first time seeing this account
		usageCache.notifyWindowReset(accountId, data, "zai", callback);

		expect(callback).not.toHaveBeenCalled();
	});
});
