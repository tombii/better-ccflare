import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
	it("charges a stream to its completion hour after persistence", async () => {
		await event("crosses-hour", NOW - 3000, 2000, 2);
		const events = await db.getApiKeySpendEventsSince(
			"key",
			Date.parse("2026-11-13T13:00:00Z"),
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
