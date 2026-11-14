import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { setCostTrackingEnabled } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { ApiKeyLimit } from "@better-ccflare/types";
import {
	ApiKeySpendCounter,
	SPEND_RESYNC_TTL_MS,
} from "../handlers/api-key-spend";

const NOW = Date.parse("2026-11-13T12:30:00Z");
const limit: ApiKeyLimit = {
	id: "l",
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
});
function counter(db: object, timeout = 1000) {
	const result = new ApiKeySpendCounter(db as DatabaseOperations, {
		syncTimeoutMs: timeout,
	});
	counters.push(result);
	return result;
}
function state(c: ApiKeySpendCounter) {
	return c as unknown as {
		spendResetPoints: Map<string, number>;
		limitGenerations: Map<string, number>;
		limitSyncTokens: Map<string, symbol>;
		limitEntries: Map<string, { events: unknown[] }>;
	};
}
const aggregate = (totalUsd: number, events: unknown[] = []) => ({
	calendar: [
		{
			window: "month",
			totals: [{ model: "opus", requestedModel: null, totalUsd }],
		},
	],
	events,
});

describe("bounded rolling reconciliation", () => {
	it("reports the next scoped expiry below budget without retaining settled history", async () => {
		const duration = 30 * 86400000;
		const firstTimestampMs = NOW - 86400000;
		const c = counter({
			getApiKeySpendReconciliation: async () => ({
				calendar: [
					{
						window: "month",
						totals: [
							{
								model: "opus",
								requestedModel: null,
								totalUsd: 0.5,
								firstTimestampMs,
							},
							{
								model: "sonnet",
								requestedModel: null,
								totalUsd: 0.1,
								firstTimestampMs: NOW - 2 * 86400000,
							},
						],
					},
				],
				events: [],
			}),
		});
		const snapshot = await c.getLimitSnapshot(
			"k",
			{ ...limit, scopeModel: "opus" },
			"rolling",
			NOW,
		);
		expect(snapshot.spentUsd).toBe(0.5);
		expect(snapshot.resetMs).toBe(firstTimestampMs + duration);
	});
	it("does not report a past aggregate expiry after its retained edge expires", async () => {
		const duration = 30 * 86400000;
		const firstTimestampMs = NOW - duration + 1000;
		const c = counter({
			getApiKeySpendReconciliation: async () => ({
				calendar: [
					{
						window: "month",
						totals: [
							{
								model: "opus",
								requestedModel: null,
								totalUsd: 0.5,
								firstTimestampMs,
							},
						],
					},
				],
				events: [
					{
						requestId: "edge",
						timestamp: firstTimestampMs,
						costUsd: 0.1,
						model: "opus",
						requestedModel: null,
					},
				],
			}),
		});
		expect((await c.getLimitSnapshot("k", limit, "rolling", NOW)).resetMs).toBe(
			NOW + 1000,
		);
		const snapshot = await c.getLimitSnapshot(
			"k",
			limit,
			"rolling",
			NOW + 1000,
		);
		expect(snapshot.spentUsd).toBeCloseTo(0.4);
		expect(snapshot.resetMs).toBeNull();
	});
	it("reports a newly recorded next expiry after an empty aggregate snapshot", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const c = counter({
			getApiKeySpendReconciliation: async () => aggregate(0),
		});
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		c.record("k", 0.25, "opus", NOW, "local");
		const snapshot = await c.getLimitSnapshot("k", limit, "rolling", NOW);
		expect(snapshot.spentUsd).toBe(0.25);
		expect(snapshot.resetMs).toBe(NOW + 30 * 86400000);
	});
	it("gives reset reads and reconciliation separate timeout budgets", async () => {
		const c = counter(
			{
				getApiKey: async () => {
					await Bun.sleep(25);
					return null;
				},
				getApiKeySpendEventsSince: async () => {
					await Bun.sleep(25);
					return [];
				},
			},
			40,
		);
		expect(
			(await c.getLimitSnapshot("k", limit, "rolling", NOW)).spentUsd,
		).toBe(0);
	});
	it("bounds background key reads and continues to the next active key", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const read = mock(
			async (_id: string): Promise<{ isActive: boolean } | null> => null,
		);
		const sync = mock(async () => []);
		const c = counter({ getApiKey: read, getApiKeySpendEventsSince: sync }, 15);
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		await c.getLimitSnapshot(
			"second",
			{ ...limit, apiKeyId: "second" },
			"rolling",
			NOW,
		);
		read.mockImplementation(async (id) =>
			id === "k" ? new Promise(() => {}) : { isActive: true },
		);
		const result = await Promise.race([
			c.reconcileActiveKeys().then(() => "done"),
			Bun.sleep(100).then(() => "hung"),
		]);
		expect(result).toBe("done");
		expect(sync).toHaveBeenCalledTimes(3);
	});
	it("clears lifecycle maps on forget and eviction without reviving a stale sync", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const sync = mock(async () => []);
		const c = counter({
			getApiKey: async () => ({ isActive: false }),
			getApiKeySpendEventsSince: sync,
		});
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		c.applySpendReset("k", NOW);
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		c.forget("k");
		for (const map of [state(c).limitGenerations, state(c).limitSyncTokens])
			expect(map.size).toBe(0);
		// The reset boundary survives forget() for in-flight reservations; it is
		// released by eviction below.
		expect(state(c).spendResetPoints.get("k")).toBe(NOW);
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		await c.reconcileActiveKeys();
		for (const map of [
			state(c).spendResetPoints,
			state(c).limitGenerations,
			state(c).limitSyncTokens,
		])
			expect(map.size).toBe(0);
	});
	it("keeps settled rolling spend in SQL totals while retaining only bounded expiry events", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const duration = 30 * 86400000;
		const query = mock(async (..._args: unknown[]) =>
			aggregate(3, [
				{
					requestId: "expiring",
					timestamp: NOW - duration + 1000,
					costUsd: 0.5,
					model: "opus",
					requestedModel: null,
				},
				{
					requestId: "ack",
					timestamp: NOW - 1000,
					costUsd: 0.5,
					model: "opus",
					requestedModel: null,
				},
			]),
		);
		const c = counter({ getApiKeySpendReconciliation: query });
		const first = await c.getLimitSnapshot("k", limit, "rolling", NOW);
		expect(first.spentUsd).toBe(3);
		// The unknown settled middle cannot promise an exact Retry-After.
		expect(first.resetMs).toBeNull();
		expect(query.mock.calls[0]?.length).toBe(6);
		expect([...state(c).limitEntries.values()][0].events).toHaveLength(2);
		expect(
			(await c.getLimitSnapshot("k", limit, "rolling", NOW + 1000)).spentUsd,
		).toBe(2.5);
		query.mockRejectedValueOnce(new Error("unavailable"));
		await expect(
			c.getLimitSnapshot(
				"k",
				limit,
				"rolling",
				NOW + 2 * SPEND_RESYNC_TTL_MS + 1,
				true,
			),
		).rejects.toThrow("unavailable");
	});
	it("still reports exact relief when the bounded expiry tail suffices", async () => {
		const duration = 30 * 86400000;
		const c = counter({
			getApiKeySpendReconciliation: async () =>
				aggregate(1.1, [
					{
						requestId: "expiring",
						timestamp: NOW - duration + 1000,
						costUsd: 0.2,
						model: "opus",
						requestedModel: null,
					},
				]),
		});
		const snapshot = await c.getLimitSnapshot("k", limit, "rolling", NOW);
		expect(snapshot.resetMs).toBe(NOW + 1000);
	});
	it.each([
		"block",
		"warn",
	] as const)("keeps expired rolling totals fail-closed only for %s limits", async (enforce) => {
		const query = mock(async () => aggregate(3));
		const c = counter({ getApiKeySpendReconciliation: query });
		const row = { ...limit, enforce };
		await c.getLimitSnapshot("k", row, "rolling", NOW);
		expect(c.shouldFailClosed("k", [row], "rolling", "opus", null, NOW)).toBe(
			false,
		);
		const expiredAt = NOW + 2 * SPEND_RESYNC_TTL_MS + 1;
		query.mockRejectedValueOnce(new Error("unavailable"));
		await expect(
			c.getLimitSnapshot("k", row, "rolling", expiredAt),
		).rejects.toThrow("unavailable");
		expect(
			c.getCachedChecks("k", [row], "rolling", "opus", null, expiredAt),
		).toEqual([]);
		expect(
			c.shouldFailClosed("k", [row], "rolling", "opus", null, expiredAt),
		).toBe(enforce === "block");
	});
	it("does not let an old in-flight snapshot publish after forget and reload", async () => {
		let resolveOld!: (events: never[]) => void;
		const old = new Promise<never[]>((resolve) => {
			resolveOld = resolve;
		});
		const sync = mock(async () => old);
		const c = counter({ getApiKeySpendEventsSince: sync });
		const checking = c.getLimitSnapshot("k", limit, "rolling", NOW);
		const outcome = checking.then(
			() => "published",
			() => "superseded",
		);
		await Promise.resolve();
		await Promise.resolve();
		c.forget("k");
		sync.mockResolvedValueOnce([]);
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		resolveOld([]);
		expect(await outcome).toBe("superseded");
		expect(
			(await c.getLimitSnapshot("k", limit, "rolling", NOW)).spentUsd,
		).toBe(0);
	});
	it("does not retain generation metadata for failed cold limits reads", async () => {
		const c = counter({
			getApiKeyLimits: async () => {
				throw new Error("unavailable");
			},
		});
		for (let i = 0; i < 20; i++)
			await expect(c.getLimitsForKey(`cold-${i}`)).rejects.toThrow(
				"unavailable",
			);
		await c.reconcileActiveKeys();
		expect(state(c).limitGenerations.size).toBe(0);
	});
	it("preserves generation metadata owned by a concurrent spend snapshot", async () => {
		let rejectRead!: (reason: Error) => void;
		const read = new Promise<never>((_resolve, reject) => {
			rejectRead = reject;
		});
		const c = counter({
			getApiKeyLimits: async () => read,
			getApiKeySpendReconciliation: async () => aggregate(3),
		});
		const checking = c.getLimitsForKey("k");
		const failed = checking.catch((error) => error);
		await c.getLimitSnapshot("k", limit, "rolling", NOW);
		const generation = state(c).limitGenerations.get("k");
		rejectRead(new Error("unavailable"));
		expect((await failed).message).toBe("unavailable");
		expect(state(c).limitGenerations.get("k")).toBe(generation);
		expect(
			(await c.getLimitSnapshot("k", limit, "rolling", NOW)).spentUsd,
		).toBe(3);
	});
	it("does not retain a generation when refreshing an empty limits cache fails", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const read = mock(async () => []);
		const c = counter({ getApiKeyLimits: read });
		expect(await c.getLimitsForKey("k")).toEqual([]);
		clock.mockReturnValue(NOW + SPEND_RESYNC_TTL_MS + 1);
		read.mockRejectedValueOnce(new Error("unavailable"));
		expect(await c.getLimitsForKey("k")).toEqual([]);
		await c.reconcileActiveKeys();
		expect(state(c).limitGenerations.size).toBe(0);
	});
	it("does not restore reset metadata from an evicted in-flight read", async () => {
		let resolveKey!: (key: { spendResetAt: number }) => void;
		const read = new Promise<{ spendResetAt: number }>((resolve) => {
			resolveKey = resolve;
		});
		const c = counter({
			getApiKey: async () => read,
			getApiKeySpendEventsSince: async () => [],
		});
		const checking = c.getLimitSnapshot("k", limit, "rolling", NOW);
		const outcome = checking.catch(() => {});
		await Promise.resolve();
		c.forget("k");
		resolveKey({ spendResetAt: NOW });
		await outcome;
		expect(state(c).spendResetPoints.size).toBe(0);
		expect(state(c).limitGenerations.size).toBe(0);
	});
	it("bounds middle-window relief by the hour end without double-counting exact events", async () => {
		const duration = 30 * 86400000;
		const hour = 3600000;
		const middle = NOW - 10 * 86400000 + 1234;
		const bucketEnd = (Math.floor(middle / hour) + 1) * hour;
		const c = counter({
			getApiKeySpendReconciliation: async () => ({
				calendar: [
					{
						window: "month",
						totals: [{ model: "opus", requestedModel: null, totalUsd: 1.7 }],
						buckets: [
							{
								timestamp: bucketEnd,
								costUsd: 1,
								model: "mapped",
								requestedModel: "opus",
							},
							{
								timestamp: bucketEnd - hour,
								costUsd: 99,
								model: "sonnet",
								requestedModel: null,
							},
						],
					},
				],
				events: [
					{
						requestId: "edge",
						timestamp: NOW - duration + 1000,
						costUsd: 0.5,
						model: "opus",
						requestedModel: null,
					},
					{
						requestId: "ack",
						timestamp: NOW - 1000,
						costUsd: 0.2,
						model: "opus",
						requestedModel: null,
					},
				],
			}),
		});
		const snapshot = await c.getLimitSnapshot(
			"k",
			{ ...limit, scopeModel: "opus" },
			"rolling",
			NOW,
		);
		expect(snapshot.spentUsd).toBe(1.7);
		expect(snapshot.resetMs).toBe(bucketEnd + duration);
		expect(snapshot.resetMs).toBeGreaterThanOrEqual(middle + duration);
		expect(snapshot.resetMs).toBeLessThanOrEqual(middle + duration + hour);
		expect([...state(c).limitEntries.values()][0].events).toHaveLength(2);
		spyOn(Date, "now").mockReturnValue(NOW);
		c.record("k", 0.9, "opus", NOW, "local");
		const local = await c.getLimitSnapshot(
			"k",
			{ ...limit, scopeModel: "opus" },
			"rolling",
			NOW,
		);
		expect(local.spentUsd).toBeCloseTo(2.6);
		// The new completion keeps the key blocked beyond the middle bucket.
		expect(local.resetMs).toBe(NOW - 1000 + duration);
	});
	it("does not infer middle-window relief when an older adapter supplies no buckets", async () => {
		const c = counter({
			getApiKeySpendReconciliation: async () => aggregate(1.5),
		});
		expect(
			(await c.getLimitSnapshot("k", limit, "rolling", NOW)).resetMs,
		).toBeNull();
	});
	it("keeps reservations counted when deriving bucketed relief", async () => {
		setCostTrackingEnabled(true);
		spyOn(Date, "now").mockReturnValue(NOW);
		const c = counter({
			getApiKeySpendReconciliation: async () => ({
				...aggregate(1.5),
				calendar: [
					{
						window: "month",
						totals: [{ model: "opus", requestedModel: null, totalUsd: 1.5 }],
						buckets: [
							{
								timestamp: NOW - 10 * 86400000,
								costUsd: 1.5,
								model: "opus",
								requestedModel: null,
							},
						],
					},
				],
			}),
		});
		await c.checkAndReserve(
			"k",
			"inflight",
			[{ ...limit, limitUsd: 10 }],
			"rolling",
			null,
			"opus",
			1,
			NOW,
		);
		const snapshot = await c.getLimitSnapshot("k", limit, "rolling", NOW);
		expect(snapshot.reservedUsd).toBe(1);
		expect(snapshot.resetMs).toBeNull();
	});
	it("keeps in-flight reservations when a limit edit forgets cached totals", async () => {
		setCostTrackingEnabled(true);
		spyOn(Date, "now").mockReturnValue(NOW);
		const c = counter({
			getApiKey: async () => ({ isActive: true, spendResetAt: NOW - 86400000 }),
			getApiKeySpendReconciliation: async () => aggregate(0),
		});
		await c.checkAndReserve(
			"k",
			"inflight",
			[limit],
			"calendar",
			null,
			"opus",
			0.6,
			NOW,
		);
		// A limits PUT drops cached totals, not the persisted reset boundary that
		// in-flight reservations were admitted under.
		c.forget("k");
		const snapshot = await c.getLimitSnapshot("k", limit, "calendar", NOW);
		expect(snapshot.reservedUsd).toBeCloseTo(0.6);
		expect(state(c).spendResetPoints.get("k")).toBe(NOW - 86400000);
	});
	it("releases a reset boundary once nothing for the key remains", async () => {
		const c = counter({ getApiKeySpendEventsSince: async () => [] });
		c.applySpendReset("idle", NOW);
		await c.reconcileActiveKeys();
		expect(state(c).spendResetPoints.size).toBe(0);
	});
});
