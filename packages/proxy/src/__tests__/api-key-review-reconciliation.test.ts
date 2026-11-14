import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
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
		for (const map of [
			state(c).spendResetPoints,
			state(c).limitGenerations,
			state(c).limitSyncTokens,
		])
			expect(map.size).toBe(0);
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
	it("does not infer relief across the omitted middle from acknowledgement events", async () => {
		const duration = 30 * 86400000;
		const c = counter({
			getApiKeySpendReconciliation: async () =>
				aggregate(1.5, [
					{
						requestId: "edge",
						timestamp: NOW - duration + 1000,
						costUsd: 0.1,
						model: "opus",
						requestedModel: null,
					},
					{
						requestId: "ack",
						timestamp: NOW - 1000,
						costUsd: 1,
						model: "opus",
						requestedModel: null,
					},
				]),
		});
		expect(
			(await c.getLimitSnapshot("k", limit, "rolling", NOW)).resetMs,
		).toBeNull();
	});
});
