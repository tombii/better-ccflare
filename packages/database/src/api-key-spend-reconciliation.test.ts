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
	it("returns rolling SUMs without materializing a month of settled history", async () => {
		const start = NOW - 30 * 86400000;
		await event("edge", start + 1000, 0, 2);
		await event("settled", NOW - 86400000, 0, 4);
		await event("ack", NOW - 1000, 0, 1);
		await event("outside", start, 0, 99);
		const result = await db.getApiKeySpendReconciliation(
			"key",
			[{ window: "month", startMs: start, endMs: NOW + 30 * 86400000 }],
			start,
			NOW - 600000,
			NOW,
			120000,
		);
		expect(result.calendar[0].totals[0].totalUsd).toBe(7);
		expect(result.calendar[0].totals[0].firstTimestampMs).toBe(start + 1000);
		expect(result.events.map(({ requestId }) => requestId).sort()).toEqual([
			"ack",
			"edge",
		]);
		expect(result.calendar[0].buckets).toEqual([
			{
				timestamp: (Math.floor((NOW - 86400000) / 3600000) + 1) * 3600000,
				costUsd: 4,
				model: "opus",
				requestedModel: "sonnet",
			},
		]);
	});
	it("keeps hourly buckets disjoint from every rolling window edge and acknowledgement", async () => {
		const monthStart = NOW - 30 * 86400000;
		const dayStart = NOW - 86400000;
		await event("month-edge", monthStart + 1000, 0, 1);
		await event("day-edge", dayStart + 1000, 0, 2);
		await event("middle-a", NOW - 3600000, 0, 4, "mapped", "opus");
		await event("middle-b", NOW - 3600000 + 1000, 0, 8, "mapped", "opus");
		await event("ack", NOW - 1000, 0, 16);
		const query = spyOn(db.getAdapter(), "query");
		try {
			const result = await db.getApiKeySpendReconciliation(
				"key",
				[
					{ window: "month", startMs: monthStart, endMs: NOW + 30 * 86400000 },
					{ window: "day", startMs: dayStart, endMs: NOW + 86400000 },
				],
				monthStart,
				NOW - 600000,
				NOW,
				120000,
			);
			expect(result.events.map(({ requestId }) => requestId).sort()).toEqual([
				"ack",
				"day-edge",
				"month-edge",
			]);
			expect(
				result.calendar.map(({ totals }) =>
					totals.reduce((sum, row) => sum + row.totalUsd, 0),
				),
			).toEqual([31, 30]);
			for (const window of result.calendar) {
				expect(window.buckets).toEqual([
					{
						timestamp: Math.floor(NOW / 3600000) * 3600000,
						costUsd: 12,
						model: "mapped",
						requestedModel: "opus",
					},
				]);
			}
			// This query is shared by both adapters; BIGINT integer arithmetic
			// avoids SQLite-only datetime functions and PostgreSQL int overflow.
			const [sql, params] = query.mock.calls[0];
			expect(sql).toContain("CAST(completed_ms / 3600000 AS BIGINT)");
			expect(sql.match(/\?/g)?.length).toBe(params?.length);
		} finally {
			query.mockRestore();
		}
	});
	it("collapses a busy settled hour to one bucket, including its exact lower boundary", async () => {
		const hourStart = Math.floor(NOW / 3600000) * 3600000 - 3600000;
		for (let index = 0; index < 100; index++) {
			await event(`settled-${index}`, hourStart + index, 0, 1);
		}
		const start = NOW - 30 * 86400000;
		const result = await db.getApiKeySpendReconciliation(
			"key",
			[{ window: "month", startMs: start, endMs: NOW + 30 * 86400000 }],
			start,
			NOW - 600000,
			NOW,
			120000,
		);
		expect(result.events).toEqual([]);
		expect(result.calendar[0].buckets).toEqual([
			{
				timestamp: hourStart + 3600000,
				costUsd: 100,
				model: "opus",
				requestedModel: "sonnet",
			},
		]);
	});
	it("includes rolling costs recorded exactly at the reset boundary", async () => {
		await db.createApiKey({
			id: "key",
			name: "key",
			hashedKey: "hash",
			prefixLast8: "last8",
			createdAt: 1,
			isActive: true,
		});
		await db.resetApiKeySpend("key", NOW - 1000, "admin");
		await event("boundary", NOW - 1000, 0, 3);
		await event("before-reset", NOW - 1001, 0, 99);
		const start = NOW - 3600000;
		const result = await db.getApiKeySpendReconciliation(
			"key",
			[{ window: "hour", startMs: start, endMs: NOW + 3600000 }],
			start,
			NOW - 600000,
			NOW,
			120000,
		);
		expect(result.calendar[0].totals[0].totalUsd).toBe(3);
		expect(result.events.map(({ requestId }) => requestId)).toEqual([
			"boundary",
		]);
	});
});
