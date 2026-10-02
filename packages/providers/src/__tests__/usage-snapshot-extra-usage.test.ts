/**
 * "Use extra usage": an account whose plan window reads 100% stays routable
 * while its provider reports billed capacity beyond the plan — Codex credits,
 * Anthropic extra usage / spend — but only once the operator has switched it
 * on. The snapshot carries that as `extraUsageAvailable`, and the shared
 * `isUsageExhausted` predicate honours it, so selection, /health and the
 * pool-exhausted body all agree.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { isUsageExhausted, setUseExtraUsage } from "@better-ccflare/core";
import type { UsageData } from "../usage-fetcher";
import {
	getRepresentativeUsageSnapshotForProvider,
	hasExtraUsageCapacity,
} from "../usage-fetcher";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const WEEKLY_RESET = "2030-01-04T00:00:00.000Z";

function spentWeekly(extra: Partial<UsageData> = {}): UsageData {
	return {
		seven_day: { utilization: 100, resets_at: WEEKLY_RESET },
		...extra,
	} as UsageData;
}

afterEach(() => {
	setUseExtraUsage(false);
});

describe("hasExtraUsageCapacity — what each provider reports", () => {
	it("codex: purchased credits or an unlimited allowance", () => {
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: true, unlimited: false, balance: "5" },
				}),
				"codex",
			),
		).toBe(true);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: false, unlimited: true, balance: null },
				}),
				"codex",
			),
		).toBe(true);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: false, unlimited: false, balance: "0" },
				}),
				"codex",
			),
		).toBe(false);
		expect(hasExtraUsageCapacity(spentWeekly(), "codex")).toBe(false);
	});

	it("anthropic: extra usage that is enabled and not yet spent", () => {
		const extra = (is_enabled: boolean, utilization: number | null) =>
			spentWeekly({
				extra_usage: {
					is_enabled,
					monthly_limit: 100,
					used_credits: 0,
					utilization,
				},
			});
		expect(hasExtraUsageCapacity(extra(true, 30), "anthropic")).toBe(true);
		expect(hasExtraUsageCapacity(extra(true, null), "anthropic")).toBe(true);
		expect(hasExtraUsageCapacity(extra(true, 100), "anthropic")).toBe(false);
		expect(hasExtraUsageCapacity(extra(false, 0), "anthropic")).toBe(false);
	});

	it("anthropic: the 2026 spend block wins over legacy extra_usage", () => {
		const both = spentWeekly({
			spend: { enabled: false },
			extra_usage: {
				is_enabled: true,
				monthly_limit: null,
				used_credits: null,
				utilization: null,
			},
		});
		expect(hasExtraUsageCapacity(both, "anthropic")).toBe(false);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({ spend: { enabled: true, percent: 40 } }),
				"anthropic",
			),
		).toBe(true);
		expect(
			hasExtraUsageCapacity(
				spentWeekly({ spend: { enabled: true, percent: 100 } }),
				"anthropic",
			),
		).toBe(false);
	});

	it("reports nothing for a provider with no extra-usage surface", () => {
		expect(
			hasExtraUsageCapacity(
				spentWeekly({
					credits: { has_credits: true, unlimited: true, balance: null },
				}),
				"anthropic",
			),
		).toBe(false);
		expect(hasExtraUsageCapacity(null, "codex")).toBe(false);
		expect(hasExtraUsageCapacity(spentWeekly(), "openai-compatible")).toBe(
			false,
		);
	});
});

describe("getRepresentativeUsageSnapshotForProvider — extra usage", () => {
	const codexWithCredits = spentWeekly({
		credits: { has_credits: true, unlimited: false, balance: "5" },
	});

	it("keeps today's behaviour while the switch is off", () => {
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			codexWithCredits,
			"codex",
		);

		expect(snapshot?.utilization).toBe(100);
		expect(snapshot?.extraUsageAvailable).toBeUndefined();
		expect(
			isUsageExhausted(
				snapshot?.utilization ?? null,
				snapshot?.resetMs,
				NOW,
				snapshot?.extraUsageAvailable,
			),
		).toBe(true);
	});

	it("marks a spent window servable on extra usage once the switch is on", () => {
		setUseExtraUsage(true);
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			codexWithCredits,
			"codex",
		);

		// The window itself is reported as it is — only admission changes.
		expect(snapshot?.utilization).toBe(100);
		expect(snapshot?.resetMs).toBe(Date.parse(WEEKLY_RESET));
		expect(snapshot?.extraUsageAvailable).toBe(true);
		expect(
			isUsageExhausted(
				snapshot?.utilization ?? null,
				snapshot?.resetMs,
				NOW,
				snapshot?.extraUsageAvailable,
			),
		).toBe(false);
	});

	it("does not mark an account that has no credits, even with the switch on", () => {
		setUseExtraUsage(true);
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			spentWeekly({
				credits: { has_credits: false, unlimited: false, balance: "0" },
			}),
			"codex",
		);

		expect(snapshot?.extraUsageAvailable).toBeUndefined();
		expect(
			isUsageExhausted(
				snapshot?.utilization ?? null,
				snapshot?.resetMs,
				NOW,
				snapshot?.extraUsageAvailable,
			),
		).toBe(true);
	});

	it("applies the same rule to an anthropic account with extra usage", () => {
		setUseExtraUsage(true);
		const snapshot = getRepresentativeUsageSnapshotForProvider(
			spentWeekly({ spend: { enabled: true, percent: 10 } }),
			"anthropic",
		);

		expect(snapshot?.extraUsageAvailable).toBe(true);
	});
});
