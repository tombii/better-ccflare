/**
 * "Use extra usage" must read the same on every operator-facing surface as it
 * does in account selection: an account serving past a spent window on extra
 * usage is routable, is not counted as usage_exhausted, and is labelled as
 * running on extra usage rather than as exhausted or OK.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { isUseExtraUsageEnabled, setUseExtraUsage } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { createConfigHandlers } from "../config";
import { computePoolStatus } from "../health";
import { computeRateLimitStatusDisplay } from "../rate-limit-status";

const NOW = Date.UTC(2030, 0, 1);
const RESET = NOW + 60 * 60000;

afterEach(() => {
	setUseExtraUsage(false);
});

describe("computeRateLimitStatusDisplay — extra usage", () => {
	const base = {
		rate_limit_status: null,
		rate_limit_reset: null,
		rate_limited_until: null,
		usageUtilization: 100,
		usageResetMs: RESET,
	};

	it("labels a spent window served on extra usage, with the window's reset", () => {
		expect(
			computeRateLimitStatusDisplay(
				{ ...base, usageExtraUsageAvailable: true },
				NOW,
			),
		).toBe("extra_usage (60m)");
	});

	it("keeps usage_exhausted when extra usage is not available", () => {
		expect(computeRateLimitStatusDisplay(base, NOW)).toBe(
			"usage_exhausted (60m)",
		);
		expect(
			computeRateLimitStatusDisplay(
				{ ...base, usageExtraUsageAvailable: false },
				NOW,
			),
		).toBe("usage_exhausted (60m)");
	});

	it("never claims extra usage for a window that still has headroom", () => {
		expect(
			computeRateLimitStatusDisplay(
				{ ...base, usageUtilization: 40, usageExtraUsageAvailable: true },
				NOW,
			),
		).toBe("OK");
	});
});

describe("computePoolStatus — extra usage", () => {
	it("counts an account on extra usage as routable and not as usage_exhausted", () => {
		const accounts = [
			{ id: "on-credits", name: "on-credits", provider: "codex" },
			{ id: "spent", name: "spent", provider: "codex" },
		].map(
			(a) => ({ paused: false, rate_limited_until: null, ...a }) as Account,
		);

		const status = computePoolStatus(accounts, NOW, (account) => ({
			utilization: 100,
			resetMs: RESET,
			extraUsageAvailable: account.id === "on-credits" ? true : undefined,
		}));

		expect(status.routable).toBe(1);
		expect(status.usage_exhausted).toBe(1);
	});
});

describe("/api/config/use-extra-usage", () => {
	it("reports the switch and pushes a write into the runtime mirror", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-extra-usage-api-"));
		try {
			const handlers = createConfigHandlers(
				new Config(join(dir, "config.json")),
			);

			const before = await handlers.getUseExtraUsage().json();
			expect(before).toEqual({ enabled: false, source: "default" });

			const res = await handlers.setUseExtraUsage(
				new Request("http://localhost/api/config/use-extra-usage", {
					method: "POST",
					body: JSON.stringify({ enabled: true }),
				}),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				success: true,
				enabled: true,
				source: "file",
				effective: true,
			});
			expect(isUseExtraUsageEnabled()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a payload that is not a boolean and changes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-extra-usage-api-"));
		try {
			const handlers = createConfigHandlers(
				new Config(join(dir, "config.json")),
			);
			const res = await handlers.setUseExtraUsage(
				new Request("http://localhost/api/config/use-extra-usage", {
					method: "POST",
					body: JSON.stringify({ enabled: "yes" }),
				}),
			);
			expect(res.status).toBe(400);
			expect(isUseExtraUsageEnabled()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
