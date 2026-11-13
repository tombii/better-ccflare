import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { ApiKeyLimit } from "@better-ccflare/types";
import {
	ApiKeySpendCounter,
	SPEND_RESYNC_TTL_MS,
} from "../handlers/api-key-spend";

const NOW = Date.parse("2026-11-13T12:30:00Z");
const limit = (extra: Partial<ApiKeyLimit> = {}): ApiKeyLimit => ({
	id: "l",
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
function counter(
	events: Array<{ timestamp: number; costUsd: number; model: string | null }>,
) {
	const query = mock(async () => events);
	const result = new ApiKeySpendCounter({
		getApiKeySpendEventsSince: query,
	} as unknown as DatabaseOperations);
	counters.push(result);
	return { result, query };
}
afterEach(() => {
	for (const c of counters) c.dispose();
	counters.length = 0;
	mock.restore();
});
describe("multi-window spend counters", () => {
	it("waits for enough rolling spend to expire before returning relief", async () => {
		const { result } = counter([
			{ timestamp: NOW - 3_000_000, costUsd: 2, model: "claude-opus-4-6" },
			{ timestamp: NOW - 2_000_000, costUsd: 4, model: "claude-opus-4-6" },
			{ timestamp: NOW - 1_000_000, costUsd: 3, model: "claude-opus-4-6" },
		]);
		const snapshot = await result.getLimitSnapshot(
			"k",
			limit(),
			"rolling",
			NOW,
		);
		expect(snapshot.spentUsd).toBe(9);
		expect(snapshot.resetMs).toBe(NOW + 1_600_000);
		expect(snapshot.exceeded).toBe(true);
	});
	it("expires rolling requests exactly at the boundary", async () => {
		const { result } = counter([
			{ timestamp: NOW - 3_600_000, costUsd: 20, model: "opus" },
			{ timestamp: NOW - 1000, costUsd: 2, model: "opus" },
		]);
		expect(
			(await result.getLimitSnapshot("k", limit(), "rolling", NOW)).spentUsd,
		).toBe(2);
	});
	it("keeps key-wide, family, exact-model, and window totals independent", async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const { result, query } = counter([
			{ timestamp: NOW - 1000, costUsd: 2, model: "claude-opus-4-6" },
			{ timestamp: NOW - 1000, costUsd: 3, model: "claude-sonnet-4-6" },
		]);
		expect(
			(await result.getLimitSnapshot("k", limit(), "calendar", NOW)).spentUsd,
		).toBe(5);
		expect(
			(
				await result.getLimitSnapshot(
					"k",
					limit({ scopeModel: "opus" }),
					"calendar",
					NOW,
				)
			).spentUsd,
		).toBe(2);
		expect(
			(
				await result.getLimitSnapshot(
					"k",
					limit({ scopeModel: "claude-opus-4-5" }),
					"calendar",
					NOW,
				)
			).spentUsd,
		).toBe(0);
		await result.getLimitSnapshot(
			"k",
			limit({ window: "day" }),
			"calendar",
			NOW,
		);
		result.record("k", 1, "claude-opus-4-6", NOW);
		expect(
			(await result.getLimitSnapshot("k", limit(), "calendar", NOW)).spentUsd,
		).toBe(6);
		expect(
			(
				await result.getLimitSnapshot(
					"k",
					limit({ scopeModel: "opus" }),
					"calendar",
					NOW,
				)
			).spentUsd,
		).toBe(3);
		expect(
			(
				await result.getLimitSnapshot(
					"k",
					limit({ window: "day" }),
					"calendar",
					NOW,
				)
			).spentUsd,
		).toBe(6);
		expect(query).toHaveBeenCalledTimes(4);
	});
	it("reloads at a calendar boundary and reconciles after two minutes", async () => {
		const { result, query } = counter([
			{ timestamp: NOW - 1000, costUsd: 2, model: "opus" },
		]);
		await result.getLimitSnapshot("k", limit(), "calendar", NOW);
		await result.getLimitSnapshot(
			"k",
			limit(),
			"calendar",
			NOW + SPEND_RESYNC_TTL_MS,
		);
		await Promise.resolve();
		expect(query).toHaveBeenCalledTimes(2);
		await result.getLimitSnapshot("k", limit(), "calendar", NOW + 3_600_000);
		expect(query).toHaveBeenCalledTimes(3);
	});
	it("does not put a late completion into the next calendar hour", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(NOW);
		const { result } = counter([]);
		await result.getLimitSnapshot("k", limit(), "calendar", NOW);
		clock.mockReturnValue(NOW + 3_600_000);
		result.record("k", 10, "opus", NOW);
		expect(
			(await result.getLimitSnapshot("k", limit(), "calendar", NOW + 3_600_000))
				.spentUsd,
		).toBe(0);
	});
});

describe("budget settings changes during reconciliation", () => {
	it("does not let an old in-flight query restore rows forgotten after PUT", async () => {
		let resolveOld!: (
			events: Array<{
				timestamp: number;
				costUsd: number;
				model: string | null;
			}>,
		) => void;
		let calls = 0;
		const db = {
			getApiKeySpendEventsSince: mock(async () => {
				if (++calls === 1)
					return new Promise<
						Array<{ timestamp: number; costUsd: number; model: string | null }>
					>((resolve) => {
						resolveOld = resolve;
					});
				return [{ timestamp: NOW - 1000, costUsd: 1, model: "opus" }];
			}),
		};
		const result = new ApiKeySpendCounter(db as unknown as DatabaseOperations);
		counters.push(result);
		const stale = result.getLimitSnapshot("k", limit(), "calendar", NOW);
		result.forget("k");
		expect(
			(await result.getLimitSnapshot("k", limit(), "calendar", NOW)).spentUsd,
		).toBe(1);
		resolveOld([{ timestamp: NOW - 1000, costUsd: 99, model: "opus" }]);
		await expect(stale).rejects.toThrow("superseded");
		expect(
			(await result.getLimitSnapshot("k", limit(), "calendar", NOW)).spentUsd,
		).toBe(1);
	});
	it("does not share in-flight results between calendar and rolling modes", async () => {
		let resolveOld!: (
			events: Array<{
				timestamp: number;
				costUsd: number;
				model: string | null;
			}>,
		) => void;
		let calls = 0;
		const result = new ApiKeySpendCounter({
			getApiKeySpendEventsSince: mock(async () => {
				if (++calls === 1)
					return new Promise<
						Array<{ timestamp: number; costUsd: number; model: string | null }>
					>((resolve) => {
						resolveOld = resolve;
					});
				return [{ timestamp: NOW - 3_000_000, costUsd: 3, model: "opus" }];
			}),
		} as unknown as DatabaseOperations);
		counters.push(result);
		const stale = result.getLimitSnapshot("k", limit(), "calendar", NOW);
		expect(
			(await result.getLimitSnapshot("k", limit(), "rolling", NOW)).spentUsd,
		).toBe(3);
		resolveOld([{ timestamp: NOW - 1000, costUsd: 99, model: "opus" }]);
		await expect(stale).rejects.toThrow("superseded");
		expect(
			(await result.getLimitSnapshot("k", limit(), "rolling", NOW)).spentUsd,
		).toBe(3);
	});
	it("ignores imported requests dated in the future", async () => {
		const { result } = counter([
			{ timestamp: NOW + 1000, costUsd: 99, model: "opus" },
		]);
		expect(
			(await result.getLimitSnapshot("k", limit(), "rolling", NOW)).spentUsd,
		).toBe(0);
	});
});

describe("completions during asynchronous spend reconciliation", () => {
	for (const persisted of [false, true]) {
		it(`counts the completed request once when the SQL snapshot ${persisted ? "includes" : "omits"} it`, async () => {
			spyOn(Date, "now").mockReturnValue(NOW);
			type Event = {
				requestId: string;
				timestamp: number;
				costUsd: number;
				model: string | null;
			};
			let finish!: (events: Event[]) => void;
			let calls = 0;
			const result = new ApiKeySpendCounter({
				getApiKeySpendEventsSince: mock(async () => {
					if (++calls === 1) return [];
					return new Promise<Event[]>((resolve) => {
						finish = resolve;
					});
				}),
			} as unknown as DatabaseOperations);
			counters.push(result);
			await result.getLimitSnapshot("k", limit(), "calendar", NOW);
			const pending = result.getLimitSnapshot(
				"k",
				limit(),
				"calendar",
				NOW,
				true,
			);
			result.record("k", 2, "opus", NOW, "request-1");
			finish(
				persisted
					? [
							{
								requestId: "request-1",
								timestamp: NOW,
								costUsd: 2,
								model: "opus",
							},
						]
					: [],
			);
			expect((await pending).spentUsd).toBe(2);
			expect(
				(await result.getLimitSnapshot("k", limit(), "calendar", NOW)).spentUsd,
			).toBe(2);
		});
	}
});
