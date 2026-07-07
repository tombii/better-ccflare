/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
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
						percentage: 92,
						resetAt: Date.now() + 60 * 60 * 1000,
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
				usageData={{
					five_hour: {
						utilization: 120,
						resets_at: new Date(resetAt).toISOString(),
					},
					seven_day: null,
				}}
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
});
