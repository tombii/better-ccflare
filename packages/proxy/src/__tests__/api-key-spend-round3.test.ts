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
	limitUsd: 1,
	enforce: "block",
	createdAt: 0,
	updatedAt: 0,
	...extra,
});
type Event = {
	requestId: string;
	timestamp: number;
	costUsd: number;
	model: string | null;
};
const counters: ApiKeySpendCounter[] = [];
function make(db: object = {}, timeoutMs = 1000) {
	const counter = new ApiKeySpendCounter(
		{ getApiKeySpendEventsSince: async () => [], ...db } as DatabaseOperations,
		{ syncTimeoutMs: timeoutMs },
	);
	counters.push(counter);
	return counter;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => {
	for (const counter of counters) counter.dispose();
	counters.length = 0;
	mock.restore();
});

describe("round 3 spend admission regressions", () => {
	it.each([
		[],
		[row({ enforce: "warn" })],
		[row()],
	])("serves stale limit definitions after refresh errors (%j)", async (limits) => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const query = mock(async () => limits);
		const counter = make({ getApiKeyLimits: query });
		expect(await counter.getLimitsForKey("k")).toEqual(limits);
		clock.mockReturnValue(NOW + SPEND_RESYNC_TTL_MS + 1);
		query.mockRejectedValueOnce(new Error("DB timeout"));
		expect(await counter.getLimitsForKey("k")).toEqual(limits);
	});
	it("admits a large estimate below the actual budget and reports reservations separately", async () => {
		const counter = make();
		const [check] = await counter.checkAndReserve(
			"k",
			"large",
			[row()],
			"calendar",
			"opus",
			"opus",
			1.2,
			NOW,
		);
		expect(check.snapshot.exceeded).toBe(false);
		expect(check.snapshot.spentUsd).toBe(0);
		expect(check.snapshot.reservedUsd).toBe(1);
		const [next] = await counter.checkAndReserve(
			"k",
			"next",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.1,
			NOW,
		);
		expect(next.snapshot.exceeded).toBe(true);
		expect(next.snapshot.spentUsd).toBe(0);
	});
	it("caps a reservation at the smallest remaining applicable block budget", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const counter = make({
			getApiKeySpendEventsSince: async () => [
				{ requestId: "past", timestamp: NOW - 1, costUsd: 0.8, model: "opus" },
			],
		});
		const limits = [
			row(),
			row({ id: "day", window: "day", limitUsd: 5 }),
			row({ id: "warn", window: "week", enforce: "warn", limitUsd: 0.1 }),
		];
		const checks = await counter.checkAndReserve(
			"k",
			"large",
			limits,
			"calendar",
			"opus",
			"opus",
			2,
			NOW,
		);
		expect(checks[0].snapshot.exceeded).toBe(false);
		expect(checks[0].snapshot.spentUsd).toBe(0.8);
		expect(checks[0].snapshot.reservedUsd).toBeCloseTo(0.2);
		expect(checks[1].snapshot.reservedUsd).toBeCloseTo(0.2);
		expect(checks[2].snapshot.spentUsd).toBe(0.8);
	});
	it("drops reservations at reset but counts their real completion afterward", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const counter = make();
		await counter.checkAndReserve(
			"k",
			"inflight",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.9,
			NOW,
		);
		counter.applySpendReset("k", NOW);
		const [next] = await counter.checkAndReserve(
			"k",
			"after-reset",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.6,
			NOW,
		);
		expect(next.snapshot.exceeded).toBe(false);
		expect(next.snapshot.reservedUsd).toBe(0.6);
		counter.record("k", 0.2, "opus", NOW, "inflight");
		const snapshot = await counter.getLimitSnapshot(
			"k",
			row(),
			"calendar",
			NOW,
		);
		expect(snapshot.spentUsd).toBe(0.2);
		expect(snapshot.reservedUsd).toBe(0.6);
	});
	it("retries a reset superseding cold reconciliation instead of throwing", async () => {
		const old = deferred<Event[]>();
		let started!: () => void;
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});
		const query = mock(async () => {
			started();
			return old.promise;
		});
		const counter = make({ getApiKeySpendEventsSince: query });
		const checking = counter.checkAndReserve(
			"k",
			"r",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.1,
			NOW,
		);
		await start;
		counter.applySpendReset("k", NOW);
		query.mockResolvedValueOnce([]);
		old.resolve([
			{ requestId: "old", timestamp: NOW - 1, costUsd: 10, model: "opus" },
		]);
		const [check] = await checking;
		expect(check.snapshot.spentUsd).toBe(0);
		expect(check.snapshot.exceeded).toBe(false);
		expect(query).toHaveBeenCalledTimes(2);
	});
	it("retries when reset lands after a snapshot but before reservation publication", async () => {
		const counter = make({
			getApiKeySpendEventsSince: async () => [
				{ requestId: "old", timestamp: NOW - 1, costUsd: 2, model: "opus" },
			],
		});
		const original = counter.getLimitSnapshot.bind(counter);
		let reset = false;
		spyOn(counter, "getLimitSnapshot").mockImplementation(async (...args) => {
			const snapshot = await original(...args);
			if (!reset) {
				reset = true;
				counter.applySpendReset("k", NOW);
			}
			return snapshot;
		});
		const [check] = await counter.checkAndReserve(
			"k",
			"new",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.5,
			NOW,
		);
		expect(check.snapshot.exceeded).toBe(false);
		expect(check.snapshot.spentUsd).toBe(0);
	});
	it("expires leaked reservations after thirty minutes", async () => {
		const counter = make();
		await counter.checkAndReserve(
			"k",
			"lost",
			[row()],
			"rolling",
			"opus",
			"opus",
			1,
			NOW,
		);
		const [check] = await counter.checkAndReserve(
			"k",
			"new",
			[row()],
			"rolling",
			"opus",
			"opus",
			0.5,
			NOW + 30 * 60_000,
		);
		expect(check.snapshot.exceeded).toBe(false);
		expect(check.snapshot.spentUsd).toBe(0);
		expect(check.snapshot.reservedUsd).toBe(0.5);
	});
	it("returns promptly when a request aborts while queued behind the per-key lock", async () => {
		const old = deferred<Event[]>();
		let started!: () => void;
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});
		const counter = make({
			getApiKeySpendEventsSince: async () => {
				started();
				return old.promise;
			},
		});
		const first = counter.checkAndReserve(
			"k",
			"first",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.1,
			NOW,
		);
		await start;
		const controller = new AbortController();
		const queued = counter.checkAndReserve(
			"k",
			"queued",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.1,
			NOW,
			controller.signal,
		);
		const outcome = queued.then(
			() => "allowed",
			(error) => error.message,
		);
		controller.abort(new Error("client disconnected"));
		const result = await Promise.race([
			outcome,
			new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 50)),
		]);
		old.resolve([]);
		await first;
		await outcome;
		expect(result).toBe("client disconnected");
	});
	it("bounds a hung cold sync and releases the per-key lock for later requests", async () => {
		const old = deferred<Event[]>();
		const query = mock(async () => old.promise);
		const counter = make({ getApiKeySpendEventsSince: query }, 20);
		const first = counter.checkAndReserve(
			"k",
			"first",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.1,
			NOW,
		);
		const outcome = first.then(
			() => "allowed",
			(error) => error.message,
		);
		const result = await Promise.race([
			outcome,
			new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 60)),
		]);
		query.mockResolvedValueOnce([]);
		await outcome;
		expect(result).toContain("deadline");
		const [next] = await counter.checkAndReserve(
			"k",
			"next",
			[row()],
			"calendar",
			"opus",
			"opus",
			0.1,
			NOW,
		);
		expect(next.snapshot.exceeded).toBe(false);
		old.resolve([
			{ requestId: "late", timestamp: NOW - 1, costUsd: 99, model: "opus" },
		]);
		await Promise.resolve();
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW)).spentUsd,
		).toBe(0);
	});
	it("uses current cached totals when an explicit refresh fails", async () => {
		const query = mock(async () => [
			{ requestId: "past", timestamp: NOW - 1, costUsd: 0.2, model: "opus" },
		]);
		const counter = make({ getApiKeySpendEventsSince: query });
		await counter.getLimitSnapshot("k", row(), "calendar", NOW);
		query.mockRejectedValueOnce(new Error("DB timeout"));
		expect(
			(await counter.getLimitSnapshot("k", row(), "calendar", NOW, true))
				.spentUsd,
		).toBe(0.2);
	});
	it("excludes the replaced reservation when enforcing cached routed totals", async () => {
		const counter = make();
		await counter.checkAndReserve(
			"k",
			"same",
			[row()],
			"calendar",
			"opus",
			"opus",
			2,
			NOW,
		);
		expect(
			counter.getCachedChecks("k", [row()], "calendar", "opus", "opus", NOW)[0]
				.snapshot.exceeded,
		).toBe(true);
		const [check] = counter.getCachedChecks(
			"k",
			[row()],
			"calendar",
			"opus",
			"opus",
			NOW,
			"same",
		);
		expect(check.snapshot.exceeded).toBe(false);
		expect(check.snapshot.reservedUsd).toBe(0);
	});
	it("does not trigger warn alerts from estimates alone", async () => {
		const counter = make();
		await counter.checkAndReserve(
			"k",
			"open",
			[row({ enforce: "warn" })],
			"calendar",
			"opus",
			"opus",
			10,
			NOW,
		);
		const snapshot = await counter.getLimitSnapshot(
			"k",
			row({ enforce: "warn" }),
			"calendar",
			NOW,
		);
		expect(snapshot.spentUsd).toBe(0);
		expect(snapshot.reservedUsd).toBe(10);
		expect(snapshot.exceeded).toBe(false);
	});
	it("consumes a late database rejection for an already-aborted request", async () => {
		let rejectQuery!: (error: Error) => void;
		const query = new Promise<ApiKeyLimit[]>((_, reject) => {
			rejectQuery = reject;
		});
		const counter = make({ getApiKeyLimits: () => query });
		const controller = new AbortController();
		controller.abort(new Error("already aborted"));
		await expect(
			counter.getLimitsForKey("k", controller.signal),
		).rejects.toThrow("already aborted");
		rejectQuery(new Error("late query failure"));
		await Bun.sleep(5);
	});
	it("warn-only failures and nonmatching block limits cannot fail closed", async () => {
		const counter = make({
			getApiKeySpendEventsSince: async () => {
				throw new Error("DB timeout");
			},
		});
		const checks = await counter.checkAndReserve(
			"k",
			"warn",
			[row({ enforce: "warn" })],
			"calendar",
			"opus",
			"opus",
			1,
			NOW,
		);
		expect(checks).toEqual([]);
		expect(
			counter.shouldFailClosed(
				"k",
				[row({ scopeModel: "sonnet" })],
				"calendar",
				"opus",
				"opus",
				NOW,
			),
		).toBe(false);
		expect(
			counter.shouldFailClosed("k", [row()], "calendar", "opus", "opus", NOW),
		).toBe(true);
	});
});
