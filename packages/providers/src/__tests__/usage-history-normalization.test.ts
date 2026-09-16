/**
 * Regression coverage for the P2 bug found in review of PR #470 (issue #467):
 * `UsageHistoryRepository.recordSnapshot`'s `isWindow()` duck-type check
 * requires `{ utilization: number, resets_at: string | null }`. zai's raw
 * payload uses `{ percentage, resetAt }` (numeric epoch ms), nanogpt uses
 * `{ percentUsed (0-1 decimal), resetAt }`, and minimax uses `{ utilization,
 * resetAt (numeric epoch ms) }` — none of them match the `resets_at` string
 * key `isWindow` looks for, so `recordSnapshot` silently recorded zero rows
 * for all three providers' raw payloads, even once `onSnapshot` actually
 * fires (see usage-fetcher-snapshot-callback.test.ts).
 *
 * Fix: `normalizeUsageSnapshotForHistory` converts each provider's raw
 * payload into the internal `{ five_hour?, seven_day? }` window shape
 * (`{ utilization: number (0-100), resets_at: string | null }`) BEFORE it
 * reaches `recordSnapshot`, mirroring the existing `realWindows` normalizer
 * pattern in packages/proxy/src/codex-usage-history.ts.
 */
import { describe, expect, it } from "bun:test";
import type { MinimaxUsageData } from "../minimax-usage-fetcher";
import type { NanoGPTUsageData } from "../nanogpt-usage-fetcher";
import { normalizeUsageSnapshotForHistory } from "../usage-fetcher";
import type { ZaiUsageData } from "../zai-usage-fetcher";

describe("normalizeUsageSnapshotForHistory", () => {
	it("converts zai's {percentage, resetAt} shape to {utilization, resets_at}", () => {
		const zai: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 10,
				remaining: 90,
				percentage: 10,
				resetAt: 1_788_455_420_775,
				type: "tokens_limit",
			},
			tokens_limit_weekly: {
				used: 20,
				remaining: 80,
				percentage: 20,
				resetAt: 1_789_005_906_998,
				type: "tokens_limit_weekly",
			},
		};

		const normalized = normalizeUsageSnapshotForHistory("zai", zai);

		expect(normalized).toEqual({
			five_hour: { utilization: 10, resets_at: 1_788_455_420_775 },
			seven_day: { utilization: 20, resets_at: 1_789_005_906_998 },
		});
	});

	it("omits seven_day for a zai single-window plan (tokens_limit_weekly null)", () => {
		const zai: ZaiUsageData = {
			time_limit: null,
			tokens_limit: {
				used: 5,
				remaining: 95,
				percentage: 5,
				resetAt: 123,
				type: "tokens_limit",
			},
			tokens_limit_weekly: null,
		};

		const normalized = normalizeUsageSnapshotForHistory("zai", zai);

		expect(normalized).toEqual({
			five_hour: { utilization: 5, resets_at: 123 },
		});
	});

	it("converts nanogpt's 0-1 percentUsed to a 0-100 utilization scale", () => {
		const nanogpt: NanoGPTUsageData = {
			active: true,
			limits: { daily: 100, monthly: 1000 },
			enforceDailyLimit: true,
			daily: { used: 10, remaining: 90, percentUsed: 0.1, resetAt: 1000 },
			monthly: { used: 250, remaining: 750, percentUsed: 0.25, resetAt: 2000 },
			state: "active",
			graceUntil: null,
		};

		const normalized = normalizeUsageSnapshotForHistory("nanogpt", nanogpt);

		expect(normalized).toEqual({
			five_hour: { utilization: 10, resets_at: 1000 },
			seven_day: { utilization: 25, resets_at: 2000 },
		});
	});

	it("returns an empty object for an inactive (PayG) nanogpt account", () => {
		const nanogpt: NanoGPTUsageData = {
			active: false,
			limits: { daily: 100, monthly: 1000 },
			enforceDailyLimit: true,
			daily: { used: 0, remaining: 100, percentUsed: 0, resetAt: 1000 },
			monthly: { used: 0, remaining: 1000, percentUsed: 0, resetAt: 2000 },
			state: "inactive",
			graceUntil: null,
		};

		expect(normalizeUsageSnapshotForHistory("nanogpt", nanogpt)).toEqual({});
	});

	it("passes minimax's numeric resetAt through without string date-parsing", () => {
		const minimax: MinimaxUsageData = {
			five_hour: {
				utilization: 25,
				remainingPercent: 75,
				resetAt: 1_700_000_000_000,
				intervalMs: 5 * 60 * 60 * 1000,
			},
			seven_day: {
				utilization: 10,
				remainingPercent: 90,
				resetAt: 1_700_500_000_000,
				intervalMs: 7 * 24 * 60 * 60 * 1000,
			},
		};

		const normalized = normalizeUsageSnapshotForHistory("minimax", minimax);

		expect(normalized).toEqual({
			five_hour: { utilization: 25, resets_at: 1_700_000_000_000 },
			seven_day: { utilization: 10, resets_at: 1_700_500_000_000 },
		});
	});

	it("omits a minimax window that is null", () => {
		const minimax: MinimaxUsageData = {
			five_hour: {
				utilization: 25,
				remainingPercent: 75,
				resetAt: 1_700_000_000_000,
				intervalMs: null,
			},
			seven_day: null,
		};

		const normalized = normalizeUsageSnapshotForHistory("minimax", minimax);

		expect(normalized).toEqual({
			five_hour: { utilization: 25, resets_at: 1_700_000_000_000 },
		});
	});

	it("passes anthropic/codex/xai payloads through unchanged (no dedicated branch)", () => {
		const anthropic = {
			five_hour: { utilization: 30, resets_at: "2030-01-01T00:00:00.000Z" },
		};
		expect(normalizeUsageSnapshotForHistory("anthropic", anthropic)).toBe(
			anthropic,
		);
		expect(normalizeUsageSnapshotForHistory("codex", anthropic)).toBe(
			anthropic,
		);
		expect(normalizeUsageSnapshotForHistory("xai", anthropic)).toBe(anthropic);
	});
});
