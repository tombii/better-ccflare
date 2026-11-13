import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { DatabaseOperations } from "./database-operations";
import { DatabaseFactory } from "./factory";

let db: DatabaseOperations;
const NOW = Date.parse("2026-11-13T13:00:02Z");
beforeEach(() => {
	DatabaseFactory.initialize(":memory:");
	db = DatabaseFactory.getInstance();
});
afterEach(() => {
	DatabaseFactory.reset();
});
async function event(
	id: string,
	timestamp: number,
	duration: number,
	cost: number,
	model = "opus",
	requested = "sonnet",
) {
	await db
		.getAdapter()
		.run(
			"INSERT INTO requests (id,timestamp,response_time_ms,method,path,api_key_id,cost_usd,model,limit_model) VALUES (?,?,?,?,?,?,?,?,?)",
			[
				id,
				timestamp,
				duration,
				"POST",
				"/v1/messages",
				"key",
				cost,
				model,
				requested,
			],
		);
}
describe("budget reconciliation SQL", () => {
	for (const operation of [
		"reconciliation",
		"events",
		"spend-since",
	] as const) {
		it(`${operation} bounds the timestamp index range while retaining completion-time precision`, async () => {
			const since = NOW - 60_000;
			const maxLag = 24 * 60 * 60 * 1000;
			await event("completed-in-window", since - 1000, 2000, 2);
			await event("completed-before-window", since - 2000, 1000, 4);
			await event("beyond-completion-lag", since - maxLag - 1, maxLag + 2, 16);
			await event("future-start", NOW + 1, 0, 32);
			const adapter = db.getAdapter();
			const query = adapter.query.bind(adapter);
			const get = adapter.get.bind(adapter);
			const plans: string[] = [];
			const explain = async (sql: string, params: unknown[] = []) => {
				if (sql.includes("FROM requests")) {
					const statement = adapter
						.getSQLiteDb()
						.prepare<{ detail: string }, Array<string | number>>(
							`EXPLAIN QUERY PLAN ${sql}`,
						);
					try {
						plans.push(
							...statement
								.all(...(params as Array<string | number>))
								.map(({ detail }) => detail),
						);
					} finally {
						statement.finalize();
					}
				}
			};
			const querySpy = spyOn(adapter, "query").mockImplementation(
				async <T>(sql: string, params?: unknown[]) => {
					await explain(sql, params);
					return query<T>(sql, params);
				},
			);
			const getSpy = spyOn(adapter, "get").mockImplementation(
				async <T>(sql: string, params?: unknown[]) => {
					await explain(sql, params);
					return get<T>(sql, params);
				},
			);
			try {
				if (operation === "reconciliation") {
					const result = await db.getApiKeySpendReconciliation(
						"key",
						[{ window: "hour", startMs: since, endMs: NOW + 60_000 }],
						null,
						since,
						NOW,
					);
					expect(result.calendar[0].totals[0].totalUsd).toBe(2);
					expect(result.events.map(({ requestId }) => requestId)).toEqual([
						"completed-in-window",
					]);
				} else if (operation === "events") {
					const result = await db.getApiKeySpendEventsSince("key", since, NOW);
					expect(result.map(({ requestId }) => requestId)).toEqual([
						"completed-in-window",
					]);
				} else {
					expect(await db.getApiKeySpendSince("key", since, NOW)).toEqual({
						totalUsd: 2,
						oldestMs: since + 1000,
					});
				}
				expect(
					plans.some((plan) =>
						/idx_requests_api_key_timestamp \(api_key_id=\? AND timestamp>\? AND timestamp<\?\)/.test(
							plan,
						),
					),
				).toBe(true);
			} finally {
				querySpy.mockRestore();
				getSpy.mockRestore();
			}
		});
	}
	it("charges a stream to its completion hour after persistence", async () => {
		await event("crosses-hour", NOW - 3000, 2000, 2);
		const events = await db.getApiKeySpendEventsSince(
			"key",
			Date.parse("2026-11-13T13:00:00Z"),
			NOW,
		);
		expect(events).toHaveLength(1);
		expect(events[0].timestamp).toBe(NOW - 1000);
	});
	it("returns calendar SUMs with a short event tail, and full rolling event history only when needed", async () => {
		await event("old", NOW - 7200000, 0, 3);
		await event("tail", NOW - 1000, 0, 2);
		await event("future", NOW + 1000, 0, 99);
		const windows = [
			{
				window: "day",
				startMs: Date.parse("2026-11-13T00:00:00Z"),
				endMs: Date.parse("2026-11-14T00:00:00Z"),
			},
		];
		const calendar = await db.getApiKeySpendReconciliation(
			"key",
			windows,
			null,
			NOW - 600000,
			NOW,
		);
		expect(calendar.calendar[0].totals).toEqual([
			{ model: "opus", requestedModel: "sonnet", totalUsd: 5 },
		]);
		expect(calendar.events.map((event) => event.requestId)).toEqual(["tail"]);
		const rolling = await db.getApiKeySpendReconciliation(
			"key",
			[],
			NOW - 86400000,
			NOW - 600000,
			NOW,
		);
		expect(rolling.events.map((event) => event.requestId).sort()).toEqual([
			"old",
			"tail",
		]);
	});
});
