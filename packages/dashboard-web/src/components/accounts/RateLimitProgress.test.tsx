/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */

import { describe, expect, it } from "bun:test";
import type {
	AnthropicUsageData,
	MinimaxUsageData,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { RateLimitProgress } from "./RateLimitProgress";

describe("RateLimitProgress", () => {
	it("shows the throttling message for Zai tokens_limit windows", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={92}
				usageWindow="tokens_limit"
				usageData={{
					tokens_limit: {
						used: 92,
						remaining: 8,
						percentage: 92,
						resetAt: Date.now() + 60 * 60 * 1000,
						type: "tokens_limit",
					},
					time_limit: null,
				}}
				usageThrottledUntil={Date.now() + 10 * 60 * 1000}
				usageThrottledWindows={["tokens_limit"]}
				provider="zai"
				showWeekly
			/>,
		);

		expect(html).toContain(
			"Usage throttling enabled; requests are being delayed",
		);
		expect(html).toContain("Usage (5-hour)");
	});

	it("renders both zai token windows, not just the last one parsed", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				usageUtilization={2}
				usageWindow="seven_day"
				usageData={{
					tokens_limit: {
						used: 1,
						remaining: 99,
						percentage: 1,
						resetAt: Date.now() + 4 * 60 * 60 * 1000,
						type: "tokens_limit",
					},
					tokens_limit_weekly: {
						used: 2,
						remaining: 98,
						percentage: 2,
						resetAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
						type: "tokens_limit_weekly",
					},
					time_limit: {
						used: 0,
						remaining: 1000,
						percentage: 0,
						resetAt: Date.now() + 26 * 24 * 60 * 60 * 1000,
						type: "time_limit",
					},
				}}
				provider="zai"
				showWeekly
			/>,
		);

		expect(html).toContain("Usage (5-hour)");
		expect(html).toContain("Usage (Weekly)");
		expect(html).toContain("Usage (Time Quota)");
	});

	it("renders a generic seven_day_fable tier as 'Fable (Weekly)' with a 0% bar", () => {
		const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={10}
				usageWindow="five_hour"
				usageData={{
					five_hour: { utilization: 10, resets_at: reset },
					seven_day: { utilization: 20, resets_at: reset },
					seven_day_fable: { utilization: 0, resets_at: reset },
				}}
				provider="anthropic"
				showWeekly
			/>,
		);

		// Generic labelling: the new tier is shown without any per-tier hardcoding.
		expect(html).toContain("Usage (Fable (Weekly))");
		// utilization: 0 is a valid value — shows "0%", not "N/A".
		expect(html).toContain("0%");
		expect(html).not.toContain("N/A");
	});

	it("renders per-model weekly caps from the limits[] array (Fable red + binding)", () => {
		const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={100}
				usageWindow="seven_day"
				usageData={{
					limits: [
						{
							kind: "session",
							group: "session",
							percent: 32,
							severity: "normal",
							resets_at: reset,
							scope: null,
							is_active: false,
						},
						{
							kind: "weekly_all",
							group: "weekly",
							percent: 92,
							severity: "critical",
							resets_at: reset,
							scope: null,
							is_active: false,
						},
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 100,
							severity: "critical",
							resets_at: reset,
							scope: {
								model: { id: null, display_name: "Fable" },
								surface: null,
							},
							is_active: true,
						},
					],
				}}
				provider="anthropic"
				showWeekly
			/>,
		);
		// limits[] rows use the explicit label directly (no "Usage (" wrapper).
		expect(html).toContain("Fable (Weekly)");
		expect(html).toContain("100%");
		// severity critical -> red indicator; is_active -> "binding" marker.
		expect(html).toContain("bg-red-500");
		expect(html).toContain("binding");
		// Session / Weekly group headers.
		expect(html).toContain("Session");
		expect(html).toContain("Weekly");
	});

	it("renders five_hour as 5-hour with N/A when its object has utilization: null", () => {
		const reset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={reset}
				usageUtilization={88}
				usageWindow="five_hour"
				usageData={{
					// Present object with null utilization must still render as 5-hour,
					// and the usageUtilization fallback (88) must NOT leak in.
					five_hour: { utilization: null, resets_at: reset },
					seven_day: { utilization: 20, resets_at: reset },
				}}
				provider="anthropic"
				showWeekly
			/>,
		);

		expect(html).toContain("Usage (5-hour)");
		expect(html).toContain("N/A");
		expect(html).not.toContain("88%");
	});

	it("does not display a throttled-until time past reset for over-100% usage", () => {
		const now = Date.now();
		const resetAt = now + 30 * 1000;
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(resetAt).toISOString()}
				usageUtilization={120}
				usageWindow="five_hour"
				usageData={
					{
						five_hour: {
							utilization: 120,
							resets_at: new Date(resetAt).toISOString(),
						},
					} satisfies AnthropicUsageData
				}
				usageThrottledUntil={resetAt}
				usageThrottledWindows={["five_hour"]}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).toContain(
			"Usage throttling enabled; requests are being delayed",
		);
		expect(html).not.toContain("Until");
		expect(html).toContain("Less than 1 minute");
	});

	it("does not color the time-based fallback bar from elapsed time (m4)", () => {
		// A provider with no usage data hits the time-based else branch, where the
		// bar percentage is ELAPSED TIME, not usage — it must not turn amber/red.
		const now = Date.now();
		// ~98% elapsed of the 5-hour display window.
		const reset = new Date(now + 5 * 60 * 1000).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={reset}
				provider="openai-compatible"
				showWeekly
			/>,
		);
		expect(html).not.toContain("bg-amber-500");
		expect(html).not.toContain("bg-red-500");
	});

	it("uses the model label (not the window slug) in the scoped-row tooltip (n2)", () => {
		const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={50}
				usageWindow="seven_day"
				usageData={{
					limits: [
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 50,
							severity: "normal",
							resets_at: reset,
							scope: {
								model: { id: null, display_name: "Fable 4.5" },
								surface: null,
							},
							is_active: false,
						},
					],
				}}
				provider="anthropic"
				showWeekly
			/>,
		);
		// Tooltip renders `${label} usage` — must use the human label, not the
		// slugified window key ("Fable_4_5 …").
		expect(html).toContain("Fable 4.5 (Weekly) usage");
	});

	it("renders a real Session group-header element for limits[] rows (n5)", () => {
		const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={30}
				usageWindow="five_hour"
				usageData={{
					limits: [
						{
							kind: "session",
							group: "session",
							percent: 30,
							severity: "normal",
							resets_at: reset,
							scope: null,
							is_active: false,
						},
						{
							kind: "weekly_all",
							group: "weekly",
							percent: 40,
							severity: "normal",
							resets_at: reset,
							scope: null,
							is_active: false,
						},
					],
				}}
				provider="anthropic"
				showWeekly
			/>,
		);
		// The group header is its own element (ends in </div>), distinct from the
		// row labels which are <span>s — pins the header markup, not just the text.
		expect(html).toContain(">Session</div>");
	});

	// Regression: MiniMax Token Plan emits normalized `{ utilization, resetAt }`
	// windows under `five_hour` and `seven_day` (canonical names from
	// minimax-usage-fetcher.ts). The legacy Anthropic collector requires
	// snake_case `resets_at`, so without the dedicated MiniMax branch the 7d
	// row collapses to a single most-restrictive fallback (max of 5h/7d) — the
	// bug that hid per-window usage in production. See:
	// https://github.com/zenprocess/better-ccflare for the operator-reported
	// dashboard dead-branch class.
	it("renders MiniMax five_hour and seven_day as separate windows from each window's own utilization", () => {
		const fiveHourReset = Date.now() + 5 * 60 * 60 * 1000;
		const sevenDayReset = Date.now() + 5 * 24 * 60 * 60 * 1000;
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(fiveHourReset).toISOString()}
				usageUtilization={50}
				usageWindow="seven_day"
				usageData={
					{
						five_hour: {
							utilization: 25,
							remainingPercent: 75,
							resetAt: fiveHourReset,
							intervalMs: 5 * 60 * 60 * 1000,
						},
						seven_day: {
							utilization: 90,
							remainingPercent: 10,
							resetAt: sevenDayReset,
							intervalMs: 7 * 24 * 60 * 60 * 1000,
						},
					} satisfies MinimaxUsageData
				}
				provider="minimax"
				showWeekly
			/>,
		);
		// Both windows render as clearly labelled rows.
		expect(html).toContain("Usage (5-hour)");
		expect(html).toContain("Usage (Weekly)");
		// Each window's own utilization surfaces — 25% for 5h (free), 90% for 7d
		// (almost exhausted). The top-level usageUtilization (50, from the
		// max-of-windows fallback) MUST NOT leak into the rendered bars.
		expect(html).toContain("25%");
		expect(html).toContain("90%");
		expect(html).not.toContain("50%");
		// No N/A placeholder — both windows have a real utilization and resetAt.
		expect(html).not.toContain("N/A");
	});

	it("skips the MiniMax 7-day row entirely when seven_day is null", () => {
		const fiveHourReset = Date.now() + 5 * 60 * 60 * 1000;
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(fiveHourReset).toISOString()}
				usageUtilization={25}
				usageWindow="five_hour"
				usageData={
					{
						five_hour: {
							utilization: 25,
							remainingPercent: 75,
							resetAt: fiveHourReset,
							intervalMs: 5 * 60 * 60 * 1000,
						},
						seven_day: null,
					} satisfies MinimaxUsageData
				}
				provider="minimax"
				showWeekly
			/>,
		);
		// 5-hour still renders.
		expect(html).toContain("Usage (5-hour)");
		expect(html).toContain("25%");
		// No "Weekly" row, no N/A placeholder.
		expect(html).not.toContain("Usage (Weekly)");
		expect(html).not.toContain("N/A");
	});

	it("does NOT mis-dispatch an Anthropic seven_day payload to the MiniMax branch", () => {
		// Anthropic-style inner windows use snake_case `resets_at` (ISO string),
		// not camelCase `resetAt`. The shape probe on the inner object is what
		// keeps the legacy Anthropic collector reachable for its payloads.
		const fiveHourReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const sevenDayReset = new Date(
			Date.now() + 3 * 24 * 60 * 60 * 1000,
		).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={fiveHourReset}
				usageUtilization={10}
				usageWindow="five_hour"
				usageData={{
					five_hour: { utilization: 10, resets_at: fiveHourReset },
					seven_day: { utilization: 20, resets_at: sevenDayReset },
				}}
				provider="anthropic"
				showWeekly
			/>,
		);
		// Anthropic render path emits the legacy "Usage (5-hour)" / "Usage (Weekly)"
		// labels with the inner `resets_at` values — MiniMax branch is unreachable.
		expect(html).toContain("Usage (5-hour)");
		expect(html).toContain("Usage (Weekly)");
		expect(html).toContain("10%");
		expect(html).toContain("20%");
	});

	// -------------------------------------------------------------------------
	// Codex: OpenAI removed the 5-hour window on 2026-07-12 and restored it for
	// Plus accounts on 2026-08-25 (Pro stays weekly-only). The 5-hour row is
	// shown only when the account really reported one — a number AND a reset.
	// An unknown window (null) or a reset-less percentage stays hidden, so a
	// Pro account never shows a fabricated 0% and never the elapsed-time bar.
	// The weekly row is permanent.
	// -------------------------------------------------------------------------

	it("shows the Codex 5-hour row when the account reports a real one", () => {
		const fiveHourReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const sevenDayReset = new Date(
			Date.now() + 3 * 24 * 60 * 60 * 1000,
		).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={fiveHourReset}
				usageUtilization={63}
				usageWindow="seven_day"
				usageData={{
					five_hour: { utilization: 10, resets_at: fiveHourReset },
					seven_day: { utilization: 63, resets_at: sevenDayReset },
				}}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).toContain("Usage (5-hour)");
		expect(html).toContain(">10%<");
		expect(html).toContain("Usage (Weekly)");
		expect(html).toContain(">63%<");
	});

	it("hides the Codex 5-hour row when the window is unknown", () => {
		const sevenDayReset = new Date(
			Date.now() + 3 * 24 * 60 * 60 * 1000,
		).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={sevenDayReset}
				usageUtilization={63}
				usageWindow="seven_day"
				usageData={{
					five_hour: { utilization: null, resets_at: null },
					seven_day: { utilization: 63, resets_at: sevenDayReset },
				}}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).not.toContain("Usage (5-hour)");
		expect(html).toContain("Usage (Weekly)");
		expect(html).toContain(">63%<");
	});

	it("hides a Codex 5-hour percentage that has no reset (legacy minted zero)", () => {
		// Older caches and snapshots can still carry { utilization: 0, resets_at: null }.
		const sevenDayReset = new Date(
			Date.now() + 3 * 24 * 60 * 60 * 1000,
		).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={sevenDayReset}
				usageUtilization={63}
				usageWindow="seven_day"
				usageData={{
					five_hour: { utilization: 0, resets_at: null },
					seven_day: { utilization: 63, resets_at: sevenDayReset },
				}}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).not.toContain("Usage (5-hour)");
		expect(html).toContain("Usage (Weekly)");
	});

	it("keeps the same Anthropic payload's 5-hour row for Anthropic", () => {
		// Guard against the filter leaking out of the Codex branch: identical data,
		// different provider, both rows must survive.
		const fiveHourReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={fiveHourReset}
				usageUtilization={10}
				usageWindow="five_hour"
				usageData={{
					five_hour: { utilization: 10, resets_at: fiveHourReset },
					seven_day: { utilization: 63, resets_at: fiveHourReset },
				}}
				provider="anthropic"
				showWeekly
			/>,
		);
		expect(html).toContain("Usage (5-hour)");
		expect(html).toContain("Usage (Weekly)");
	});

	it("renders a permanent weekly row for Codex with no data at all", () => {
		// No resetIso, no usageData: previously the component bailed out and the
		// card showed nothing, which reads as "no limit". Now the weekly window is
		// shown as unavailable.
		const html = renderToStaticMarkup(
			<RateLimitProgress provider="codex" showWeekly />,
		);

		expect(html).toContain("Usage (Weekly)");
		expect(html).toContain("N/A");
		expect(html).toContain("Data unavailable");
		expect(html).not.toContain("Usage (5-hour)");
	});

	it("does not fall back to the elapsed-time bar for Codex when only a reset is known", () => {
		// The time-based fallback is hardcoded to a 5-hour window, so for Codex it
		// drew "how much of the window has passed" as if it were consumption.
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 5 * 60 * 1000).toISOString()}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).toContain("Usage (Weekly)");
		expect(html).toContain("N/A");
		expect(html).not.toContain("Rate limit window");
	});

	it("does not resurrect the Codex 5-hour row through the single-window fallback", () => {
		// usageUtilization + usageWindow="five_hour" with no full payload used to
		// take the "most restrictive window" path and print a 5-hour bar.
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={44}
				usageWindow="five_hour"
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).not.toContain("Usage (5-hour)");
		expect(html).not.toContain("44%");
		expect(html).toContain("Usage (Weekly)");
	});

	it("shows only the weekly row for the payload production actually serves", () => {
		// Copied verbatim from GET /api/accounts on 2026-08-16, after a manual
		// refresh: the 5-hour window comes back unknown (its reset had already
		// passed, so the normalizer refuses to claim a percentage) while the weekly
		// window is the real one, at its cap. This is the shape the card is judged
		// on day to day, so it gets its own case rather than a hand-made one.
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso="2026-08-20T18:30:13.000Z"
				usageUtilization={100}
				usageWindow="seven_day"
				usageData={{
					five_hour: { utilization: null, resets_at: null },
					seven_day: {
						utilization: 100,
						resets_at: "2026-08-20T18:30:13.000Z",
					},
				}}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).not.toContain("Usage (5-hour)");
		expect(html).toContain("Usage (Weekly)");
		expect(html).toContain(">100%<");
	});

	it("still warns about throttling on a window whose row was suppressed", () => {
		// Removing the 5-hour bar must not remove the notice that requests are
		// actually being delayed.
		const throttledUntil = Date.now() + 20 * 60 * 1000;
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
				usageUtilization={95}
				usageWindow="five_hour"
				usageThrottledUntil={throttledUntil}
				usageThrottledWindows={["five_hour"]}
				provider="codex"
				showWeekly
			/>,
		);

		expect(html).toContain(
			"Usage throttling enabled; requests are being delayed",
		);
		expect(html).not.toContain("Usage (5-hour)");
	});
});

describe("RateLimitProgress — usage pause threshold marker", () => {
	const anthropicUsage: AnthropicUsageData = {
		five_hour: {
			utilization: 62,
			resets_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
		},
		seven_day: {
			utilization: 40,
			resets_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
		},
	};

	it("marks the 5-hour bar at the configured threshold", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={null}
				usageUtilization={62}
				usageWindow="five_hour"
				usageData={anthropicUsage}
				provider="anthropic"
				showWeekly
				pauseThresholdFiveHour={80}
				pauseThresholdWeekly={null}
			/>,
		);

		expect(html).toContain("Pauses this account at 80%");
		expect(html).toContain("left:80%");
	});

	it("marks the weekly bar at its own threshold", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={null}
				usageUtilization={62}
				usageWindow="five_hour"
				usageData={anthropicUsage}
				provider="anthropic"
				showWeekly
				pauseThresholdFiveHour={null}
				pauseThresholdWeekly={90}
			/>,
		);

		expect(html).toContain("Pauses this account at 90%");
		expect(html).toContain("left:90%");
	});

	it("draws no marker when no threshold is set", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={null}
				usageUtilization={62}
				usageWindow="five_hour"
				usageData={anthropicUsage}
				provider="anthropic"
				showWeekly
			/>,
		);

		expect(html).not.toContain("Pauses this account at");
	});

	it("does not mark per-model weekly caps, which carry no threshold of their own", () => {
		const html = renderToStaticMarkup(
			<RateLimitProgress
				resetIso={null}
				usageUtilization={62}
				usageWindow="five_hour"
				usageData={{
					...anthropicUsage,
					seven_day_opus: {
						utilization: 95,
						resets_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
					},
				}}
				provider="anthropic"
				showWeekly
				pauseThresholdFiveHour={null}
				pauseThresholdWeekly={90}
			/>,
		);

		// Exactly one marker: the all-models weekly bar, not the Opus sub-cap.
		expect(html.split("Pauses this account at").length - 1).toBe(1);
		expect(html).toContain("Pauses this account at 90%");
	});
});
