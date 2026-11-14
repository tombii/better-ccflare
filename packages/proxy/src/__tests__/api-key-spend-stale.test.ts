import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { setCostTrackingEnabled } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type { ApiKeyLimit } from "@better-ccflare/types";
import {
	ApiKeySpendCounter,
	SPEND_RESYNC_TTL_MS,
} from "../handlers/api-key-spend";

const NOW = Date.parse("2026-11-13T12:30:00Z");
const limit: ApiKeyLimit = {
	id: "month",
	apiKeyId: "k",
	scopeModel: null,
	window: "month",
	limitUsd: 1,
	enforce: "block",
	createdAt: 0,
	updatedAt: 0,
};
const counters: ApiKeySpendCounter[] = [];
afterEach(() => {
	for (const counter of counters) counter.dispose();
	counters.length = 0;
	mock.restore();
	setCostTrackingEnabled(true);
});
function counter(query: () => Promise<unknown>) {
	const result = new ApiKeySpendCounter({
		getApiKeySpendReconciliation: query,
	} as unknown as DatabaseOperations);
	counters.push(result);
	return result;
}
function aggregate(totalUsd: number) {
	return {
		calendar: [
			{
				window: "month",
				totals: [{ model: "opus", requestedModel: null, totalUsd }],
			},
		],
		events: [],
	};
}

describe("spend totals during prolonged sync failures", () => {
	it("keeps rolling totals and local completions available after their expiry edge", async () => {
		setCostTrackingEnabled(true);
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		const query = mock(async () => aggregate(0.4));
		const c = counter(query);
		expect(
			(await c.getLimitSnapshot("k", limit, "rolling", NOW)).stale,
		).toBeUndefined();
		const staleAt = NOW + 2 * SPEND_RESYNC_TTL_MS + 1;
		clock.mockReturnValue(staleAt);
		c.record("k", 0.7, "opus", staleAt, "unpersisted");
		query.mockRejectedValue(new Error("unavailable"));
		const snapshot = await c.getLimitSnapshot("k", limit, "rolling", staleAt);
		expect(snapshot.spentUsd).toBeCloseTo(1.1);
		expect(snapshot.exceeded).toBe(true);
		expect(snapshot).toHaveProperty("stale", true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Using cached spend totals"),
		);
		const [cached] = c.getCachedChecks(
			"k",
			[limit],
			"rolling",
			"opus",
			null,
			staleAt,
		);
		expect(cached.snapshot.spentUsd).toBeCloseTo(1.1);
		expect(cached.snapshot).toHaveProperty("stale", true);
		expect(
			c.shouldFailClosed("k", [limit], "rolling", "opus", null, staleAt),
		).toBe(false);
		const [check] = await c.checkAndReserve(
			"k",
			"next",
			[limit],
			"rolling",
			"opus",
			null,
			0.1,
			staleAt,
		);
		expect(check.snapshot.exceeded).toBe(true);
	});
	it("still admits a rolling key whose conservative cached total is below budget", async () => {
		setCostTrackingEnabled(true);
		const query = mock(async () => aggregate(0.4));
		const c = counter(query);
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		query.mockRejectedValue(new Error("unavailable"));
		const [check] = await c.checkAndReserve(
			"k",
			"next",
			[limit],
			"rolling",
			"opus",
			null,
			0.1,
			NOW + 2 * SPEND_RESYNC_TTL_MS + 1,
		);
		expect(check.snapshot.spentUsd).toBe(0.4);
		expect(check.snapshot.exceeded).toBe(false);
		expect(check.snapshot).toHaveProperty("stale", true);
		query.mockResolvedValueOnce(aggregate(0.4));
		expect(
			(
				await c.getLimitSnapshot(
					"k",
					limit,
					"rolling",
					NOW + 2 * SPEND_RESYNC_TTL_MS + 2,
					true,
				)
			).stale,
		).toBeUndefined();
	});
	it("keeps calendar fallback within the same window but fails closed after rollover", async () => {
		const query = mock(async () => aggregate(0.4));
		const c = counter(query);
		await c.getLimitSnapshot("k", limit, "calendar", NOW);
		query.mockRejectedValue(new Error("unavailable"));
		const sameWindow = await c.getLimitSnapshot(
			"k",
			limit,
			"calendar",
			NOW + 2 * SPEND_RESYNC_TTL_MS + 1,
			true,
		);
		expect(sameWindow.spentUsd).toBe(0.4);
		const nextWindow = Date.parse("2026-12-01T00:00:00Z");
		await expect(
			c.getLimitSnapshot("k", limit, "calendar", nextWindow),
		).rejects.toThrow("unavailable");
		expect(
			c.getCachedChecks("k", [limit], "calendar", "opus", null, nextWindow),
		).toEqual([]);
		expect(
			c.shouldFailClosed("k", [limit], "calendar", "opus", null, nextWindow),
		).toBe(true);
	});
	it("still fails closed when rolling spend has never been loaded", async () => {
		const c = counter(async () => {
			throw new Error("unavailable");
		});
		await expect(
			c.getLimitSnapshot("k", limit, "rolling", NOW),
		).rejects.toThrow("unavailable");
		expect(c.shouldFailClosed("k", [limit], "rolling", "opus", null, NOW)).toBe(
			true,
		);
	});
});
