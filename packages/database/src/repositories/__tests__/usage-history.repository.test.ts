import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../database-operations";
import { ensureSchema, runMigrations } from "../../migrations";
import { UsageHistoryRepository } from "../usage-history.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

describe("usage_snapshots schema", () => {
	it("creates the usage_snapshots table", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='usage_snapshots'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("usage_snapshots");
		db.close();
	});

	it("creates the timestamp prune index", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_snapshots_ts'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("idx_usage_snapshots_ts");
		db.close();
	});
});

function makeRepo(db: Database): UsageHistoryRepository {
	return new UsageHistoryRepository(new BunSqlAdapter(db));
}

describe("UsageHistoryRepository", () => {
	it("records one row per usage window", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot(
			"acc1",
			{
				five_hour: { utilization: 10, resets_at: "2026-07-05T12:00:00Z" },
				seven_day: { utilization: 3, resets_at: null },
				extra_usage: {
					is_enabled: true,
					monthly_limit: 5,
					used_credits: 1,
					utilization: 20,
				},
			},
			1000,
		);
		const rows = await repo.getSeries({ accountId: "acc1" });
		// extra_usage has no resets_at → not a window → excluded
		expect(rows.map((r) => r.windowKey).sort()).toEqual([
			"five_hour",
			"seven_day",
		]);
		const fiveH = rows.find((r) => r.windowKey === "five_hour");
		expect(fiveH?.utilization).toBe(10);
		expect(fiveH?.resetsAt).toBe(new Date("2026-07-05T12:00:00Z").getTime());
		db.close();
	});

	it("records every poll (no dedup) so flat windows stay a continuous series", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const usage = { five_hour: { utilization: 10, resets_at: null } };
		await repo.recordSnapshot("acc1", usage, 1000);
		await repo.recordSnapshot("acc1", usage, 2000); // same value → still stored
		await repo.recordSnapshot(
			"acc1",
			{ five_hour: { utilization: 11, resets_at: null } },
			3000,
		);
		const rows = await repo.getSeries({
			accountId: "acc1",
			windowKey: "five_hour",
		});
		expect(rows.map((r) => r.utilization)).toEqual([10, 10, 11]);
		expect(rows.map((r) => r.timestamp)).toEqual([1000, 2000, 3000]);
		db.close();
	});

	it("skips malformed resets_at (stores null, not NaN)", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot(
			"acc1",
			{ five_hour: { utilization: 5, resets_at: "not-a-date" } },
			1000,
		);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows[0].resetsAt).toBeNull();
		db.close();
	});

	it("filters getSeries by time range and orders ascending", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot(
			"acc1",
			{ five_hour: { utilization: 1, resets_at: null } },
			1000,
		);
		await repo.recordSnapshot(
			"acc1",
			{ five_hour: { utilization: 2, resets_at: null } },
			2000,
		);
		await repo.recordSnapshot(
			"acc1",
			{ five_hour: { utilization: 3, resets_at: null } },
			3000,
		);
		const rows = await repo.getSeries({
			accountId: "acc1",
			since: 1500,
			until: 2500,
		});
		expect(rows.map((r) => r.timestamp)).toEqual([2000]);
		db.close();
	});

	it("deleteOlderThan prunes by timestamp", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot(
			"acc1",
			{ five_hour: { utilization: 1, resets_at: null } },
			1000,
		);
		await repo.recordSnapshot(
			"acc1",
			{ five_hour: { utilization: 2, resets_at: null } },
			5000,
		);
		const removed = await repo.deleteOlderThan(3000);
		expect(removed).toBe(1);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows.map((r) => r.timestamp)).toEqual([5000]);
		db.close();
	});
});

// ---------------------------------------------------------------------------
// Facade smoke test: exercise the usage-history methods through a real
// in-memory DatabaseOperations. Construction opens no background workers and
// touches no real path when given ":memory:", so it is safe in a unit test.
// ---------------------------------------------------------------------------

describe("DatabaseOperations usage-history facade", () => {
	it("round-trips a snapshot through recordUsageSnapshot / getUsageHistory", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			await dbOps.recordUsageSnapshot(
				"acc1",
				{ five_hour: { utilization: 42, resets_at: "2026-07-05T12:00:00Z" } },
				1000,
			);
			const rows = await dbOps.getUsageHistory({ accountId: "acc1" });
			expect(rows).toHaveLength(1);
			expect(rows[0].windowKey).toBe("five_hour");
			expect(rows[0].utilization).toBe(42);
			expect(rows[0].timestamp).toBe(1000);
			expect(rows[0].resetsAt).toBe(new Date("2026-07-05T12:00:00Z").getTime());
		} finally {
			await dbOps.dispose();
		}
	});

	it("getUsageHistory forwards windowKey/since/until to getSeries", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			await dbOps.recordUsageSnapshot(
				"acc1",
				{ five_hour: { utilization: 1, resets_at: null } },
				1000,
			);
			await dbOps.recordUsageSnapshot(
				"acc1",
				{ five_hour: { utilization: 2, resets_at: null } },
				2000,
			);
			await dbOps.recordUsageSnapshot(
				"acc1",
				{ seven_day: { utilization: 9, resets_at: null } },
				2000,
			);
			const rows = await dbOps.getUsageHistory({
				accountId: "acc1",
				windowKey: "five_hour",
				since: 1500,
				until: 2500,
			});
			expect(rows.map((r) => r.timestamp)).toEqual([2000]);
			expect(rows[0].windowKey).toBe("five_hour");
		} finally {
			await dbOps.dispose();
		}
	});

	it("pruneUsageSnapshots deletes rows older than the cutoff and returns the count", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			await dbOps.recordUsageSnapshot(
				"acc1",
				{ five_hour: { utilization: 1, resets_at: null } },
				1000,
			);
			await dbOps.recordUsageSnapshot(
				"acc1",
				{ five_hour: { utilization: 2, resets_at: null } },
				5000,
			);
			const removed = await dbOps.pruneUsageSnapshots(3000);
			expect(removed).toBe(1);
			const rows = await dbOps.getUsageHistory({ accountId: "acc1" });
			expect(rows.map((r) => r.timestamp)).toEqual([5000]);
		} finally {
			await dbOps.dispose();
		}
	});
});
