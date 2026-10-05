/**
 * Codex reports purchased credits next to the plan windows — as
 * `x-codex-credits-*` response headers and as the `credits` block of the
 * `wham/usage` body. The official Codex CLI reads both; a window at 100% with
 * credits left still serves. These tests pin how both surfaces land in
 * `UsageData.credits`.
 */
import { describe, expect, it } from "bun:test";
import { carryForwardCodexCredits, parseCodexUsageHeaders } from "./usage";
import { parseCodexUsagePayload } from "./usage-endpoint";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function weeklyHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		"x-codex-primary-used-percent": "100",
		"x-codex-primary-window-minutes": String(7 * 24 * 60),
		"x-codex-primary-reset-at": String(NOW_S + 100_000),
		...extra,
	});
}

describe("parseCodexUsageHeaders — credits", () => {
	it("reads credits alongside the windows", () => {
		const usage = parseCodexUsageHeaders(
			weeklyHeaders({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "false",
				"x-codex-credits-balance": "42.5",
			}),
			{ baseTimeMs: NOW_MS },
		);

		expect(usage?.seven_day?.utilization).toBe(100);
		expect(usage?.credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "42.5",
		});
	});

	it("reads an unlimited allowance with no balance", () => {
		const usage = parseCodexUsageHeaders(
			weeklyHeaders({
				"x-codex-credits-has-credits": "False",
				"x-codex-credits-unlimited": "TRUE",
			}),
			{ baseTimeMs: NOW_MS },
		);

		expect(usage?.credits).toEqual({
			has_credits: false,
			unlimited: true,
			balance: null,
		});
	});

	it("leaves credits out when the headers do not report them", () => {
		const usage = parseCodexUsageHeaders(weeklyHeaders(), {
			baseTimeMs: NOW_MS,
		});

		expect(usage?.seven_day?.utilization).toBe(100);
		expect(usage).not.toHaveProperty("credits");
	});

	it("leaves credits out when either flag is missing or unreadable", () => {
		for (const extra of [
			{ "x-codex-credits-has-credits": "true" },
			{ "x-codex-credits-unlimited": "false" },
			{
				"x-codex-credits-has-credits": "maybe",
				"x-codex-credits-unlimited": "false",
			},
		]) {
			const usage = parseCodexUsageHeaders(weeklyHeaders(extra), {
				baseTimeMs: NOW_MS,
			});
			expect(usage).not.toHaveProperty("credits");
		}
	});

	it("still has no opinion when the headers carry credits but no window", () => {
		const usage = parseCodexUsageHeaders(
			new Headers({
				"x-codex-credits-has-credits": "true",
				"x-codex-credits-unlimited": "false",
			}),
			{ baseTimeMs: NOW_MS },
		);

		expect(usage).toBeNull();
	});
});

describe("parseCodexUsagePayload — credits", () => {
	function body(credits: unknown) {
		return {
			plan_type: "plus",
			rate_limit: {
				allowed: true,
				limit_reached: true,
				primary_window: null,
				secondary_window: {
					used_percent: 100,
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_at: NOW_S + 100_000,
				},
			},
			credits,
		};
	}

	it("reads the credits block next to the windows", () => {
		const usage = parseCodexUsagePayload(
			body({ has_credits: true, unlimited: false, balance: "12.00" }),
			NOW_MS,
		);

		expect(usage?.seven_day?.utilization).toBe(100);
		expect(usage?.credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "12.00",
		});
	});

	it("keeps a numeric balance as a string so both surfaces agree", () => {
		const usage = parseCodexUsagePayload(
			body({ has_credits: true, unlimited: false, balance: 7 }),
			NOW_MS,
		);

		expect(usage?.credits?.balance).toBe("7");
	});

	it("leaves credits out when the block is missing or malformed", () => {
		for (const credits of [
			undefined,
			null,
			"lots",
			{ has_credits: "yes", unlimited: false },
			{ unlimited: true },
		]) {
			const usage = parseCodexUsagePayload(body(credits), NOW_MS);
			expect(usage?.seven_day?.utilization).toBe(100);
			expect(usage).not.toHaveProperty("credits");
		}
	});
});

describe("carryForwardCodexCredits", () => {
	const known = { has_credits: true, unlimited: false, balance: "12" };
	const windows = {
		seven_day: { utilization: 100, resets_at: "2030-01-04T00:00:00.000Z" },
	};

	it("keeps credits an earlier report established when the update says nothing about them", () => {
		expect(
			carryForwardCodexCredits({ ...windows, credits: known }, windows),
		).toEqual({ ...windows, credits: known });
	});

	it("takes the update's own credits, including running out", () => {
		const none = { has_credits: false, unlimited: false, balance: "0" };
		expect(
			carryForwardCodexCredits(
				{ ...windows, credits: known },
				{ ...windows, credits: none },
			).credits,
		).toEqual(none);
	});

	it("always takes the update's windows", () => {
		const update = {
			seven_day: { utilization: 40, resets_at: "2030-01-11T00:00:00.000Z" },
		};
		expect(
			carryForwardCodexCredits({ ...windows, credits: known }, update),
		).toEqual({ ...update, credits: known });
	});

	it("invents nothing when no credits were ever reported", () => {
		expect(carryForwardCodexCredits(null, windows)).toEqual(windows);
		expect(carryForwardCodexCredits(windows, windows)).toEqual(windows);
	});
});
