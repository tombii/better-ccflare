import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	createUsageThrottledResponse,
	getUsageThrottleStatus,
	getUsageThrottleUntil,
} from "../usage-throttling";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Codex Account",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

describe("getUsageThrottleUntil", () => {
	it("returns a future resume time when Codex usage is ahead of the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 80, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).not.toBeNull();
		expect(throttleUntil).toBeGreaterThan(now);
	});

	it("does not throttle when usage is below the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 30 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 10, resets_at: resetAt },
				seven_day: { utilization: 5, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBeNull();
	});

	it("does not double-count anthropic-like usage as Alibaba usage", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = now + 2 * 24 * 60 * 60 * 1000;

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 10,
					resets_at: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
				},
				weekly: { percentUsed: 95, resetAt },
				monthly: {
					percentUsed: 10,
					resetAt: now + 20 * 24 * 60 * 60 * 1000,
				},
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBeNull();
	});

	it("can throttle weekly usage independently from the 5-hour window", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const throttleStatus = getUsageThrottleStatus(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 95,
					resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
				},
			},
			{ fiveHourEnabled: false, weeklyEnabled: true },
			now,
		);

		expect(throttleStatus.throttledWindows).toEqual(["seven_day"]);
		expect(throttleStatus.throttleUntil).not.toBeNull();
	});

	it("caps throttleUntil at the window reset when utilization exceeds 100%", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 120, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBe(new Date(resetAt).getTime());
	});
});

describe("model-aware limits[] throttling (Phase 2a)", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const settings = { fiveHourEnabled: true, weeklyEnabled: true };
	// A weekly window that started ~1h ago -> any utilization is over the pacing line.
	const weekReset = new Date(
		NOW + 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();

	const scoped = (percent: number, displayName = "Fable") =>
		({
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					resets_at: weekReset,
					scope: {
						model: { id: null, display_name: displayName },
						surface: null,
					},
				},
			],
		}) as never;

	it("reads weekly_scoped from limits[] and throttles it (scopedMode 'all')", () => {
		const status = getUsageThrottleStatus(scoped(50), settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("seven_day_fable");
		expect(status.throttleUntil).not.toBeNull();
	});

	it("throttles a scoped Fable cap only for the matching request family (match mode)", () => {
		expect(
			getUsageThrottleUntil(scoped(50), settings, NOW, {
				requestModel: "claude-fable-5",
				scopedMode: "match",
			}),
		).not.toBeNull();
		// An Opus request over the same account is NOT throttled by the Fable cap.
		expect(
			getUsageThrottleUntil(scoped(50), settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).toBeNull();
	});

	it("skips scoped windows when the request model is unknown/combo (null) in match mode", () => {
		expect(
			getUsageThrottleUntil(scoped(50), settings, NOW, {
				requestModel: null,
				scopedMode: "match",
			}),
		).toBeNull();
	});

	it("throttles weekly_all regardless of the request model", () => {
		const data = {
			limits: [
				{ kind: "weekly_all", percent: 50, resets_at: weekReset, scope: null },
			],
		} as never;
		expect(
			getUsageThrottleUntil(data, settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).not.toBeNull();
	});

	it("throttles a dynamic seven_day_<slug> window (isWindowThrottlingEnabled default)", () => {
		const status = getUsageThrottleStatus(
			scoped(50, "Fable 4.5"),
			settings,
			NOW,
			{ scopedMode: "all" },
		);
		expect(status.throttledWindows).toContain("seven_day_fable_4_5");
	});

	it("reads limits[] instead of the flat windows for hybrid payloads (no double-count)", () => {
		const data = {
			five_hour: { utilization: 5, resets_at: weekReset },
			seven_day: { utilization: 5, resets_at: weekReset },
			limits: [
				{ kind: "weekly_all", percent: 50, resets_at: weekReset, scope: null },
			],
		} as never;
		const status = getUsageThrottleStatus(data, settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("seven_day");
		// flat five_hour is NOT emitted because the limits[] branch wins.
		expect(status.throttledWindows).not.toContain("five_hour");
	});
});

describe("review fixes (codex/grok/fable)", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const settings = { fiveHourEnabled: true, weeklyEnabled: true };
	const weekReset = new Date(
		NOW + 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();
	const fiveReset = new Date(
		NOW + 5 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();

	it("falls back to flat windows when limits[] is present but empty", () => {
		const data = {
			limits: [],
			five_hour: { utilization: 50, resets_at: fiveReset },
			seven_day: { utilization: 50, resets_at: weekReset },
		} as never;
		const status = getUsageThrottleStatus(data, settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("five_hour");
	});

	it("falls back to flat windows when every limits[] entry has null percent", () => {
		const data = {
			limits: [
				{ kind: "session", percent: null, resets_at: fiveReset, scope: null },
				{
					kind: "weekly_all",
					percent: null,
					resets_at: weekReset,
					scope: null,
				},
			],
			five_hour: { utilization: 50, resets_at: fiveReset },
			seven_day: { utilization: 50, resets_at: weekReset },
		} as never;
		const status = getUsageThrottleStatus(data, settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("five_hour");
	});

	it("does NOT throttle a scoped cap with an unmapped model family in match mode", () => {
		// "Mystery" contains no fable/opus/sonnet/haiku -> modelFamily undefined.
		const data = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 50,
					resets_at: weekReset,
					scope: {
						model: { id: null, display_name: "Mystery" },
						surface: null,
					},
				},
			],
		} as never;
		// match mode with any model -> scoped skipped (cannot attribute) -> no throttle.
		expect(
			getUsageThrottleUntil(data, settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).toBeNull();
		// all mode (display) still surfaces the cap.
		expect(
			getUsageThrottleStatus(data, settings, NOW, { scopedMode: "all" })
				.throttledWindows,
		).toContain("seven_day_mystery");
	});
});

describe("createUsageThrottledResponse", () => {
	it("returns HTTP 529 with Retry-After and an Anthropic-style overload body", async () => {
		const response = createUsageThrottledResponse([
			makeAccount({ name: "Codex A" }),
			makeAccount({ id: "acc-2", name: "Codex B" }),
		]);

		expect(response.status).toBe(529);
		expect(response.headers.get("Retry-After")).toBe("60");

		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.message).toContain("Codex A");
		expect(body.error.message).toContain("Codex B");
	});
});
