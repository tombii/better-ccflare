/**
 * Regression tests for provider-utils. These lock in the two-gate
 * contract that AccountListItem and RateLimitProgress depend on:
 *
 *   1. providerShowsWeeklyUsage MUST return true for any provider whose
 *      usage payload is shaped such that RateLimitProgress can render
 *      per-window rows. Otherwise AccountListItem passes showWeekly=false
 *      and the component falls back to a single max-of-windows bar.
 *   2. A future revert of any allow-list entry MUST be caught here —
 *      otherwise the Gate B render branch becomes unreachable in
 *      production and the bug returns silently.
 *
 * Provider strings are asserted as literals (not via PROVIDER_NAMES) so
 * this test file has no @better-ccflare/types dependency — adding one
 * pulls in a circular import that breaks PROVIDER_NAMES initialization
 * across the whole dashboard-web test process.
 */
import { describe, expect, it } from "bun:test";
import { providerShowsWeeklyUsage } from "../../utils/provider-utils";

describe("providerShowsWeeklyUsage", () => {
	it("returns true for minimax so AccountListItem passes showWeekly=true (ccflare-100)", () => {
		// Gate A for the MiniMax per-window fix. Without this entry the
		// component renders a single collapsed bar instead of separate
		// 5-hour and 7-day windows — the dashboard dead-branch bug this
		// branch is meant to fix.
		expect(providerShowsWeeklyUsage("minimax")).toBe(true);
	});

	it("returns true for alibaba-coding-plan so its five_hour/weekly/monthly branch is reachable (ccflare-100)", () => {
		// Gate A for the Alibaba per-window fix. Without this entry the
		// isAlibabaData branch in RateLimitProgress is unreachable and
		// the pool-usage eligibility set never sees Alibaba accounts.
		expect(providerShowsWeeklyUsage("alibaba-coding-plan")).toBe(true);
	});

	it("returns true for the pre-existing allow-listed providers (regression guard)", () => {
		// These were already allow-listed before this branch. Pins them
		// so a future cleanup pass doesn't quietly remove an entry the
		// dashboard still depends on.
		expect(providerShowsWeeklyUsage("anthropic")).toBe(true);
		expect(providerShowsWeeklyUsage("codex")).toBe(true);
		expect(providerShowsWeeklyUsage("nanogpt")).toBe(true);
		expect(providerShowsWeeklyUsage("zai")).toBe(true);
		expect(providerShowsWeeklyUsage("xai")).toBe(true);
	});

	it("returns false for providers without a per-window usage shape (negative coverage)", () => {
		// These providers either render a single bar (kilo credits) or no
		// usage surface at all. If any of these flip to true the dashboard
		// would dispatch an unhandled payload into the showWeekly gate.
		expect(providerShowsWeeklyUsage("kilo")).toBe(false);
		expect(providerShowsWeeklyUsage("unknown-provider")).toBe(false);
		expect(providerShowsWeeklyUsage("")).toBe(false);
	});
});
