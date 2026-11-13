import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { ApiKeyLimit } from "@better-ccflare/types";
import {
	ApiKeySpendCounter,
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
describe("spend counter review regressions", () => {
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
			1,
		);
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW)).spentUsd,
		).toBeCloseTo(4.96);
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
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW)).spentUsd,
		).toBe(4.9);
	});
	it("counts a live reservation against the new calendar window", async () => {
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
		clock.mockReturnValue(NOW + 3600000);
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW + 3600000))
				.spentUsd,
		).toBe(1);
		counter.record("k", 0.5, "opus", NOW + 3600000, "long");
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW + 3600000))
				.spentUsd,
		).toBe(0.5);
	});
	it("reports rolling relief when the proposed request will fit, including its estimate", async () => {
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
			[row()],
			"rolling",
			"opus",
			"opus",
			3,
			NOW,
		);
		expect(blocked.snapshot.spentUsd).toBe(7);
		expect(blocked.snapshot.exceeded).toBe(true);
		expect(blocked.snapshot.resetMs).toBe(NOW + 1_600_000);
		const [allowed] = await counter.checkAndReserve(
			"k",
			"retry",
			[row()],
			"rolling",
			"opus",
			"opus",
			3,
			NOW + 1_600_000,
		);
		expect(allowed.snapshot.spentUsd).toBe(5);
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
		const [blocked] = await counter.checkAndReserve(
			"k",
			"proposed",
			[row()],
			"rolling",
			"opus",
			"opus",
			2,
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
	it("keeps a long open request reserved while evicting idle keys", async () => {
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
		expect(counter.cachedLimitCount).toBe(1);
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW + 3600001))
				.spentUsd,
		).toBe(1);
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
