/**
 * Tests for the adaptive incremental-vacuum backstop:
 *   - `DatabaseOperations.getFreelistCount()` — a small PRAGMA reader.
 *   - `DatabaseOperations.incrementalVacuumAdaptive()` — drives the
 *     single-chunk `incrementalVacuum()` primitive in bounded chunks so the
 *     file actually shrinks after a retention drop (large freelist) while
 *     keeping each write transaction small.
 *
 * These run against a real on-disk temp DB. A fresh DB constructed through
 * `DatabaseOperations` is born in auto_vacuum=INCREMENTAL (2) via the schema
 * bootstrap, which is what makes `PRAGMA incremental_vacuum(N)` actually
 * return free pages to the OS.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

function tempDbPath(): string {
	return join(
		tmpdir(),
		`test-incvac-adaptive-${randomBytes(6).toString("hex")}.db`,
	);
}

/**
 * Insert `count` request + payload rows with a `bytesPerRow`-ish JSON blob so
 * the on-disk file grows by a few hundred KB. request_payloads.id is a FK to
 * requests(id) (cascade), and foreign_keys is ON, so the parent request row
 * must exist first.
 */
async function seedRows(
	dbOps: DatabaseOperations,
	count: number,
	bytesPerRow: number,
): Promise<void> {
	const adapter = dbOps.getAdapter();
	const blob = "x".repeat(bytesPerRow);
	const now = Date.now();
	for (let i = 0; i < count; i++) {
		const id = `seed-${i}-${now}`;
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, error_message, response_time_ms, failover_attempts)
			 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
			[id, now],
		);
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[id, blob, now],
		);
	}
}

describe("DatabaseOperations.getFreelistCount", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("returns a number >= 0 on a fresh DB", () => {
		const n = dbOps.getFreelistCount();
		expect(typeof n).toBe("number");
		expect(n).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(n)).toBe(true);
	});
});

describe("DatabaseOperations.incrementalVacuumAdaptive", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(async () => {
		await dbOps.dispose?.();
	});

	it("returns { reclaimedPages: 0, chunks: 0 } quickly when there are no free pages", async () => {
		// Fresh DB → no deletions → empty freelist → early return.
		expect(dbOps.getFreelistCount()).toBe(0);
		const r = await dbOps.incrementalVacuumAdaptive();
		expect(r.reclaimedPages).toBe(0);
		expect(r.chunks).toBe(0);
	});

	it("shrinks the freelist end-to-end after a bulk delete (auto_vacuum=INCREMENTAL)", async () => {
		const adapter = dbOps.getAdapter();

		// Sanity: fresh DB through DatabaseOperations is in INCREMENTAL (2).
		const { auto_vacuum } = adapter
			.getSQLiteDb()
			.query("PRAGMA auto_vacuum")
			.get() as { auto_vacuum: number };
		expect(auto_vacuum).toBe(2);

		// Grow the file: ~2000 rows of ~512 bytes of JSON ≈ ~1 MB of payload.
		await seedRows(dbOps, 2000, 512);

		// Delete everything (cascade removes payloads too).
		await adapter.run(`DELETE FROM requests`, []);

		// Checkpoint the WAL so the freed pages land on the main-file freelist.
		await adapter.run(`PRAGMA wal_checkpoint(TRUNCATE)`, []);

		const freeBefore = dbOps.getFreelistCount();
		expect(freeBefore).toBeGreaterThan(0);

		const r = await dbOps.incrementalVacuumAdaptive({
			chunkPages: 64,
			maxPagesPerTick: 100000,
		});

		const freeAfter = dbOps.getFreelistCount();
		expect(freeAfter).toBeLessThan(freeBefore);
		expect(r.reclaimedPages).toBeGreaterThan(0);
		expect(r.chunks).toBeGreaterThan(0);
		// With a generous per-tick budget the freelist should fully drain.
		expect(freeAfter).toBe(0);
	});

	it("respects maxPagesPerTick (bounds the number of chunks)", async () => {
		const adapter = dbOps.getAdapter();

		await seedRows(dbOps, 2000, 512);
		await adapter.run(`DELETE FROM requests`, []);
		await adapter.run(`PRAGMA wal_checkpoint(TRUNCATE)`, []);

		const freeBefore = dbOps.getFreelistCount();
		expect(freeBefore).toBeGreaterThan(0);

		// Cap reclaim at 32 pages with 16-page chunks → at most ceil(32/16)=2
		// chunks should run.
		const r = await dbOps.incrementalVacuumAdaptive({
			chunkPages: 16,
			maxPagesPerTick: 32,
		});

		expect(r.chunks).toBeLessThanOrEqual(2);
		// Freelist still has pages left because the per-tick budget was small.
		expect(dbOps.getFreelistCount()).toBeGreaterThan(0);
	});
});
