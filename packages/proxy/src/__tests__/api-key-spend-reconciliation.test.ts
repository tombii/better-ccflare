import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { ApiKeyLimit } from "@better-ccflare/types";
import {
	ApiKeySpendCounter,
	SPEND_IDLE_TTL_MS,
	SPEND_PENDING_TTL_MS,
	SPEND_RESYNC_TTL_MS,
} from "../handlers/api-key-spend";

const NOW = Date.parse("2026-11-13T12:30:00Z");
const row = (extra: Partial<ApiKeyLimit> = {}): ApiKeyLimit => ({
	id: "hour",
	apiKeyId: "k",
	scopeModel: null,
	window: "hour",
	limitUsd: 5,
	enforce: "block",
	createdAt: 0,
	updatedAt: 0,
	...extra,
});
const counters: ApiKeySpendCounter[] = [];
afterEach(() => {
	for (const counter of counters) counter.dispose();
	mock.restore();
});
function make(
	events: Array<{
		requestId: string;
		timestamp: number;
		costUsd: number;
		model: string | null;
	}> = [],
) {
	const db = { getApiKeySpendEventsSince: mock(async () => events) };
	const counter = new ApiKeySpendCounter(db as unknown as DatabaseOperations);
	counters.push(counter);
	return { counter, db };
}
function retainedState(counter: ApiKeySpendCounter) {
	return counter as unknown as {
		pendingRecords: Map<string, Map<string, { timestamp: number }>>;
		lastAccess: Map<string, number>;
		keyLimits: Map<string, unknown>;
		limitGenerations: Map<string, number>;
		refreshTimer: ReturnType<typeof setTimeout> | null;
	};
}
describe("spend counter review regressions", () => {
	it("retains no completion history or activity timestamps for unlimited keys", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const counter = new ApiKeySpendCounter({
			getApiKeyLimits: async () => [],
		} as unknown as DatabaseOperations);
		counters.push(counter);
		for (let key = 0; key < 100; key++) {
			for (let completion = 0; completion < 100; completion++) {
				await counter.getLimitsForKey(`unlimited-${key}`);
				counter.record(`unlimited-${key}`, 1, "opus", NOW);
			}
		}
		const state = retainedState(counter);
		expect(state.pendingRecords.size).toBe(0);
		expect(state.lastAccess.size).toBe(0);
		expect(counter.cachedLimitCount).toBe(0);
		clock.mockReturnValue(NOW + SPEND_PENDING_TTL_MS + 1);
		await counter.reconcileActiveKeys();
		expect(state.keyLimits.size).toBe(0);
		expect(state.limitGenerations.size).toBe(0);
	});
	it("prunes expired pending completions without any limit rows to reconcile", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const query = mock(async () => []);
		const counter = new ApiKeySpendCounter({
			getApiKeyLimits: async () => [row()],
			getApiKeySpendEventsSince: query,
		} as unknown as DatabaseOperations);
		counters.push(counter);
		await counter.getLimitsForKey("k");
		counter.record("k", 1, "opus", NOW, "expired");
		clock.mockReturnValue(NOW + SPEND_PENDING_TTL_MS + 1);
		counter.record("k", 2, "opus", Date.now(), "fresh");
		await counter.reconcileActiveKeys();
		const state = retainedState(counter);
		expect([...(state.pendingRecords.get("k")?.keys() ?? [])]).toEqual([
			"fresh",
		]);
		expect(query).not.toHaveBeenCalled();
		clock.mockReturnValue(NOW + 2 * SPEND_PENDING_TTL_MS + 2);
		await counter.reconcileActiveKeys();
		expect(state.pendingRecords.size).toBe(0);
	});
	it("keeps scheduled cleanup alive after forgetting the last limited key", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const timeouts = spyOn(globalThis, "setTimeout");
		const counter = new ApiKeySpendCounter({
			getApiKeyLimits: async () => [row()],
		} as unknown as DatabaseOperations);
		counters.push(counter);
		await counter.getLimitsForKey("k");
		counter.record("k", 1, "opus", NOW, "pending");
		counter.forget("k");
		const state = retainedState(counter);
		async function fireRefresh(timestamp: number) {
			const scheduled = timeouts.mock.calls.find(
				([, delay]) => delay === SPEND_RESYNC_TTL_MS,
			);
			if (!scheduled) throw new Error("Missing scheduled spend cleanup");
			timeouts.mockClear();
			clock.mockReturnValue(timestamp);
			if (state.refreshTimer) clearTimeout(state.refreshTimer);
			scheduled[0]();
			await Promise.resolve();
			await Promise.resolve();
		}
		await fireRefresh(NOW + SPEND_RESYNC_TTL_MS);
		expect(state.pendingRecords.size).toBe(1);
		expect(state.refreshTimer).not.toBeNull();
		await fireRefresh(NOW + SPEND_PENDING_TTL_MS + 1);
		expect(state.pendingRecords.size).toBe(0);
		expect(state.refreshTimer).not.toBeNull();
		await fireRefresh(NOW + SPEND_IDLE_TTL_MS + 1);
		expect(state.lastAccess.size).toBe(0);
		expect(state.refreshTimer).toBeNull();
	});
	it("drops retained completions and activity when refreshed limits are empty", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const query = mock(async (): Promise<ApiKeyLimit[]> => [row()]);
		const counter = new ApiKeySpendCounter({
			getApiKeyLimits: query,
			getApiKeySpendEventsSince: async () => [],
		} as unknown as DatabaseOperations);
		counters.push(counter);
		await counter.getLimitsForKey("k");
		await counter.getLimitSnapshot("k", row(), "calendar", NOW);
		counter.record("k", 1, "opus", NOW, "old");
		clock.mockReturnValue(NOW + SPEND_RESYNC_TTL_MS + 1);
		query.mockResolvedValueOnce([]);
		expect(await counter.getLimitsForKey("k")).toEqual([]);
		counter.record("k", 2, "opus", Date.now(), "unlimited");
		const state = retainedState(counter);
		expect(state.pendingRecords.size).toBe(0);
		expect(state.lastAccess.size).toBe(0);
		expect(counter.cachedLimitCount).toBe(0);
	});
	it("retains completions recorded before a reconciliation while the writer lags", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const { counter } = make();
		const limit = row();
		await counter.getLimitSnapshot("k", limit, "calendar", NOW);
		counter.record("k", 2, "opus", NOW, "lagged");
		expect(
			(await counter.getLimitSnapshot("k", limit, "calendar", NOW, true))
				.spentUsd,
		).toBe(2);
		expect(
			(
				await counter.getLimitSnapshot(
					"k",
					limit,
					"calendar",
					NOW + SPEND_RESYNC_TTL_MS,
					true,
				)
			).spentUsd,
		).toBe(2);
	});
	it("deduplicates a lagged completion when its writer finally commits", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const events: Array<{
			requestId: string;
			timestamp: number;
			costUsd: number;
			model: string | null;
		}> = [];
		const { counter } = make(events);
		const limit = row();
		await counter.getLimitSnapshot("k", limit, "calendar", NOW);
		counter.record("k", 2, "opus", NOW, "lagged");
		await counter.getLimitSnapshot("k", limit, "calendar", NOW, true);
		events.push({
			requestId: "lagged",
			timestamp: NOW,
			costUsd: 2,
			model: "opus",
		});
		expect(
			(await counter.getLimitSnapshot("k", limit, "calendar", NOW, true))
				.spentUsd,
		).toBe(2);
	});
	it("atomically reserves parallel requests near a block limit and releases errors/aborts", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const { counter } = make([
			{ requestId: "past", timestamp: NOW - 1000, costUsd: 4.9, model: "opus" },
		]);
		const checks = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				counter.checkAndReserve(
					"k",
					`r${index}`,
					[row()],
					"calendar",
					"opus",
					"opus",
					0.06,
					NOW,
				),
			),
		);
		expect(checks.filter((check) => !check[0].snapshot.exceeded)).toHaveLength(
			2,
		);
		const reserved = await counter.getLimitSnapshot(
			"k",
			row(),
			"calendar",
			NOW,
		);
		expect(reserved.spentUsd).toBe(4.9);
		expect(reserved.reservedUsd).toBeCloseTo(0.1);
		counter.releaseReservation("r0");
		expect(
			(
				await counter.checkAndReserve(
					"k",
					"after-error",
					[row()],
					"calendar",
					"opus",
					"opus",
					0.06,
					NOW,
				)
			)[0].snapshot.exceeded,
		).toBe(false);
		counter.releaseReservation("after-error");
		counter.releaseReservation("r1");
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW)).spentUsd,
		).toBe(4.9);
	});
	it("counts a live reservation against the new calendar window", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW + 60_000);
		const { counter } = make();
		await counter.checkAndReserve(
			"k",
			"long",
			[row()],
			"calendar",
			"opus",
			"opus",
			1,
			NOW + 60_000,
		);
		clock.mockReturnValue(NOW + 1800000);
		const open = await counter.getLimitSnapshot(
			"k",
			row(),
			"calendar",
			NOW + 1800000,
		);
		expect(open.spentUsd).toBe(0);
		expect(open.reservedUsd).toBe(1);
		counter.record("k", 0.5, "opus", NOW + 1800000, "long");
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW + 1800000))
				.spentUsd,
		).toBe(0.5);
	});
	it("reports rolling relief from actual spend independently of a new estimate", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const { counter } = make([
			{
				requestId: "oldest",
				timestamp: NOW - 3_000_000,
				costUsd: 1,
				model: "opus",
			},
			{
				requestId: "next",
				timestamp: NOW - 2_000_000,
				costUsd: 1,
				model: "opus",
			},
			{
				requestId: "newest",
				timestamp: NOW - 1_000_000,
				costUsd: 2,
				model: "opus",
			},
		]);
		const [blocked] = await counter.checkAndReserve(
			"k",
			"proposed",
			[row({ limitUsd: 3 })],
			"rolling",
			"opus",
			"opus",
			3,
			NOW,
		);
		expect(blocked.snapshot.spentUsd).toBe(4);
		expect(blocked.snapshot.exceeded).toBe(true);
		expect(blocked.snapshot.resetMs).toBe(NOW + 1_600_000);
		const [allowed] = await counter.checkAndReserve(
			"k",
			"retry",
			[row({ limitUsd: 3 })],
			"rolling",
			"opus",
			"opus",
			3,
			NOW + 1_600_000,
		);
		expect(allowed.snapshot.spentUsd).toBe(2);
		expect(allowed.snapshot.reservedUsd).toBe(1);
		expect(allowed.snapshot.exceeded).toBe(false);
	});
	it("does not promise rolling relief for estimates that cannot fit without an open request finishing", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const { counter } = make();
		await counter.checkAndReserve(
			"k",
			"open",
			[row()],
			"rolling",
			"opus",
			"opus",
			4,
			NOW,
		);
		const [allowed] = await counter.checkAndReserve(
			"k",
			"proposed",
			[row()],
			"rolling",
			"opus",
			"opus",
			2,
			NOW,
		);
		expect(allowed.snapshot.exceeded).toBe(false);
		expect(allowed.snapshot.reservedUsd).toBe(5);
		const [blocked] = await counter.checkAndReserve(
			"k",
			"third",
			[row()],
			"rolling",
			"opus",
			"opus",
			0.1,
			NOW,
		);
		expect(blocked.snapshot.exceeded).toBe(true);
		expect(blocked.snapshot.resetMs).toBeNull();
	});
	it("batches calendar rows per key using aggregate totals and evicts idle keys", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const limits = [
			row(),
			row({ id: "day", window: "day" }),
			row({ id: "opus", scopeModel: "opus" }),
		];
		const query = mock(async () => ({
			calendar: limits.map((limit) => ({
				window: limit.window,
				totals: [{ model: "opus", requestedModel: null, totalUsd: 2 }],
			})),
			events: [],
		}));
		const db = {
			getApiKeyLimits: mock(async () => limits),
			getApiKey: mock(async () => ({ id: "k", isActive: true })),
			getApiKeySpendReconciliation: query,
		};
		const counter = new ApiKeySpendCounter(db as unknown as DatabaseOperations);
		counters.push(counter);
		await counter.getLimitsForKey("k");
		for (const limit of limits)
			expect(
				(await counter.getLimitSnapshot("k", limit, "calendar", NOW)).spentUsd,
			).toBe(2);
		expect(query).toHaveBeenCalledTimes(1);
		clock.mockReturnValue(NOW + 3600001);
		await counter.reconcileActiveKeys();
		expect(query).toHaveBeenCalledTimes(1);
		expect(counter.cachedLimitCount).toBe(0);
	});
	it.each([
		false,
		true,
	])("evicts disabled or deleted keys before scheduled reconciliation (deleted=%s)", async (deleted) => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const limits = [row()];
		const query = mock(async () => ({
			calendar: [{ window: "hour", totals: [] }],
			events: [],
		}));
		const getKey = mock(
			async () =>
				({ id: "k", isActive: true }) as {
					id: string;
					isActive: boolean;
				} | null,
		);
		const counter = new ApiKeySpendCounter({
			getApiKeyLimits: async () => limits,
			getApiKey: getKey,
			getApiKeySpendReconciliation: query,
		} as unknown as DatabaseOperations);
		counters.push(counter);
		await counter.getLimitsForKey("k");
		await counter.getLimitSnapshot("k", row(), "calendar", NOW);
		getKey.mockResolvedValueOnce(deleted ? null : { id: "k", isActive: false });
		await counter.reconcileActiveKeys();
		expect(counter.cachedLimitCount).toBe(0);
		expect(query).toHaveBeenCalledTimes(1);
	});
	it("expires leaked reservations so idle keys can be evicted", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const { counter } = make();
		await counter.checkAndReserve(
			"k",
			"long",
			[row()],
			"calendar",
			"opus",
			"opus",
			1,
			NOW,
		);
		clock.mockReturnValue(NOW + 3600001);
		await counter.reconcileActiveKeys();
		expect(counter.cachedLimitCount).toBe(0);
		const next = await counter.getLimitSnapshot(
			"k",
			row(),
			"calendar",
			NOW + 3600001,
		);
		expect(next.spentUsd).toBe(0);
		expect(next.reservedUsd).toBe(0);
	});
	it("handles concurrent cold snapshots for different scopes without a primed row cache", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const { counter } = make([
			{ requestId: "r", timestamp: NOW, costUsd: 2, model: "opus" },
		]);
		const snapshots = await Promise.all([
			counter.getLimitSnapshot("k", row(), "calendar", NOW),
			counter.getLimitSnapshot(
				"k",
				row({ scopeModel: "opus" }),
				"calendar",
				NOW,
			),
			counter.getLimitSnapshot("k", row({ window: "day" }), "calendar", NOW),
		]);
		expect(snapshots.map((snapshot) => snapshot.spentUsd)).toEqual([2, 2, 2]);
	});
});
