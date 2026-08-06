/**
 * Tests for UsageHistoryRepository.deleteOlderThan.
 *
 * usage_snapshots is an append-only time series with no surrogate key, so
 * retention pruning batches on the natural composite key
 * (account_id, timestamp, window_key). Regression coverage for #384: a
 * single unbounded DELETE could exceed PostgreSQL's statement_timeout once
 * the table grew large, causing retention cleanup to fail forever.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { UsageHistoryRepository } from "../repositories/usage-history.repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function insertSnapshot(
	db: Database,
	accountId: string,
	timestamp: number,
	windowKey: string,
): void {
	db.run(
		`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
		 VALUES (?, ?, ?, ?, ?)`,
		[accountId, timestamp, windowKey, 42.5, null],
	);
}

function countSnapshots(db: Database): number {
	const row = db.query("SELECT COUNT(*) as n FROM usage_snapshots").get() as {
		n: number;
	};
	return row.n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UsageHistoryRepository.deleteOlderThan", () => {
	let db: Database;
	let repo: UsageHistoryRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new UsageHistoryRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("returns 0 when there is nothing to delete", async () => {
		const removed = await repo.deleteOlderThan(Date.now());
		expect(removed).toBe(0);
	});

	it("deletes snapshots older than the cutoff", async () => {
		const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
		insertSnapshot(db, "acct-1", old, "five_hour");

		const removed = await repo.deleteOlderThan(
			Date.now() - 7 * 24 * 60 * 60 * 1000,
		);

		expect(removed).toBe(1);
		expect(countSnapshots(db)).toBe(0);
	});

	it("preserves snapshots younger than the cutoff", async () => {
		const recent = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
		insertSnapshot(db, "acct-1", recent, "five_hour");

		const removed = await repo.deleteOlderThan(
			Date.now() - 7 * 24 * 60 * 60 * 1000,
		);

		expect(removed).toBe(0);
		expect(countSnapshots(db)).toBe(1);
	});

	it("removes ALL old snapshots even when there are more than one batch's worth (regression for #384)", async () => {
		const old = Date.now() - 95 * 24 * 60 * 60 * 1000; // 95 days ago
		const oldCount = 2500; // exceeds the 2000-row batch size

		// Vary account_id/window_key per row so the composite key
		// (account_id, timestamp, window_key) stays unique even when several
		// rows share the same millisecond timestamp.
		for (let i = 0; i < oldCount; i++) {
			insertSnapshot(db, `acct-${i}`, old + (i % 50), "five_hour");
		}

		expect(countSnapshots(db)).toBe(oldCount);

		const removed = await repo.deleteOlderThan(
			Date.now() - 90 * 24 * 60 * 60 * 1000,
		);

		expect(removed).toBe(oldCount);
		expect(countSnapshots(db)).toBe(0);
	});

	it("deletes only old rows and preserves recent rows when both coexist across multiple batches", async () => {
		const old = Date.now() - 95 * 24 * 60 * 60 * 1000;
		const recent = Date.now() - 1 * 24 * 60 * 60 * 1000;
		const oldCount = 2200; // exceeds the 2000-row batch size
		const recentCount = 10;

		for (let i = 0; i < oldCount; i++) {
			insertSnapshot(db, `old-acct-${i}`, old + (i % 50), "five_hour");
		}
		for (let i = 0; i < recentCount; i++) {
			insertSnapshot(db, `recent-acct-${i}`, recent, "seven_day");
		}

		const removed = await repo.deleteOlderThan(
			Date.now() - 90 * 24 * 60 * 60 * 1000,
		);

		expect(removed).toBe(oldCount);
		expect(countSnapshots(db)).toBe(recentCount);
	});
});
