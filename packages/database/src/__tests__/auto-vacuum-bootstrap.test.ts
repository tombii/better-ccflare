/**
 * Tests for auto_vacuum bootstrap and the no-fallback contract of
 * `DatabaseOperations.incrementalVacuum()` / `bootstrapAutoVacuum()`.
 *
 * Background: before this fix, `incrementalVacuum()` would silently run a
 * full `VACUUM` on the main thread when `auto_vacuum != 2`. On a multi-GB
 * DB that froze the proxy for many minutes every hour. The fix:
 *
 *   1. `ensureSchema()` sets `PRAGMA auto_vacuum = INCREMENTAL` before any
 *      table — fresh DBs are born in mode 2 with no VACUUM required.
 *   2. `bootstrapAutoVacuum()` migrates existing DBs (mode 0) to mode 2 in
 *      one shot, intended to be called at server startup before HTTP bind.
 *   3. `incrementalVacuum()` is now a no-op when mode != 2 (no destructive
 *      fallback).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";
import { ensureSchema } from "../migrations";

function makeTempDbPath(): string {
	return path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-autovac-test-")),
		"test.db",
	);
}

function readAutoVacuumMode(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return (db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number })
			.auto_vacuum;
	} finally {
		db.close();
	}
}

describe("ensureSchema: auto_vacuum on fresh DBs", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("sets auto_vacuum to INCREMENTAL (2) on a fresh in-memory DB", () => {
		ensureSchema(db);
		const { auto_vacuum } = db.query("PRAGMA auto_vacuum").get() as {
			auto_vacuum: number;
		};
		expect(auto_vacuum).toBe(2);
	});

	it("sets auto_vacuum BEFORE creating tables (verifiable from a file-backed DB)", () => {
		const dbPath = makeTempDbPath();
		try {
			const fileDb = new Database(dbPath, { create: true });
			try {
				ensureSchema(fileDb);
			} finally {
				fileDb.close();
			}
			// After ensureSchema runs on a fresh file-backed DB, the header
			// records mode 2. If the PRAGMA had been issued AFTER `CREATE
			// TABLE`, this would still read 0 — SQLite ignores auto_vacuum
			// changes on non-empty DBs without a VACUUM.
			expect(readAutoVacuumMode(dbPath)).toBe(2);
		} finally {
			fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
		}
	});
});

describe("DatabaseOperations.bootstrapAutoVacuum", () => {
	let dbPath: string;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-bootstrap-test-"));
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("migrates an existing DB from auto_vacuum=NONE (0) to INCREMENTAL (2)", async () => {
		// Simulate a pre-fix install: create a DB and a table BEFORE setting
		// any auto_vacuum mode. SQLite locks the choice in the header at
		// first-write time, so auto_vacuum stays at 0 (NONE).
		{
			const legacyDb = new Database(dbPath, { create: true });
			try {
				legacyDb.exec("CREATE TABLE smoke (id INTEGER)");
				legacyDb.exec("INSERT INTO smoke VALUES (1)");
			} finally {
				legacyDb.close();
			}
		}
		expect(readAutoVacuumMode(dbPath)).toBe(0);

		const dbOps = new DatabaseOperations(dbPath);
		try {
			const result = dbOps.bootstrapAutoVacuum();
			expect(result.migrated).toBe(true);
			expect(result.modeBefore).toBe(0);
			expect(result.modeAfter).toBe(2);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		} finally {
			await dbOps.close();
		}

		expect(readAutoVacuumMode(dbPath)).toBe(2);
	});

	it("is a no-op when the DB is already in INCREMENTAL mode", async () => {
		// Fresh DB through DatabaseOperations — ensureSchema sets mode 2
		// before any table exists, so it sticks in the DB header.
		const dbOps = new DatabaseOperations(dbPath);
		try {
			expect(readAutoVacuumMode(dbPath)).toBe(2);
			const result = dbOps.bootstrapAutoVacuum();
			expect(result.migrated).toBe(false);
			expect(result.modeBefore).toBe(2);
			expect(result.modeAfter).toBe(2);
			expect(result.durationMs).toBe(0);
		} finally {
			await dbOps.close();
		}
	});
});

describe("DatabaseOperations.incrementalVacuum: no destructive fallback", () => {
	let dbPath: string;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-incvac-test-"));
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("is a no-op when auto_vacuum != 2 (does NOT run a fallback VACUUM)", async () => {
		// Simulate the pre-fix wedge: a DB that's in auto_vacuum=0 because it
		// pre-dates the ensureSchema-sets-mode-2 change. The buggy version
		// would call `PRAGMA auto_vacuum = INCREMENTAL` + full `VACUUM` here,
		// rewriting the entire file on the main thread. The fix's contract:
		// log a debug line, return, leave auto_vacuum alone.
		{
			const legacyDb = new Database(dbPath, { create: true });
			try {
				// Create a table BEFORE any auto_vacuum PRAGMA fires — this is
				// how a pre-fix install ended up with mode 0 stored in the
				// DB header. A handful of rows is enough; we don't need
				// thousands.
				legacyDb.exec("CREATE TABLE smoke (id INTEGER)");
				legacyDb.exec("INSERT INTO smoke (id) VALUES (1), (2), (3), (4), (5)");
			} finally {
				legacyDb.close();
			}
		}
		expect(readAutoVacuumMode(dbPath)).toBe(0);

		const dbOps = new DatabaseOperations(dbPath);
		try {
			// MUST NOT throw, MUST NOT flip the mode (the previous
			// implementation flipped it as a side effect, which is exactly
			// what kicked off the multi-minute VACUUM that hung the proxy).
			await dbOps.incrementalVacuum(8000);
			expect(readAutoVacuumMode(dbPath)).toBe(0);
		} finally {
			await dbOps.close();
		}
	});

	it("runs without throwing when auto_vacuum == 2", async () => {
		// Fresh DB → ensureSchema sets mode 2.
		const dbOps = new DatabaseOperations(dbPath);
		try {
			expect(readAutoVacuumMode(dbPath)).toBe(2);
			// 0 reclaimable pages on a fresh DB; the call should still
			// succeed without throwing. The worker round-trip is what we're
			// exercising here, not the page-move arithmetic.
			await dbOps.incrementalVacuum(1);
		} finally {
			await dbOps.close();
		}
	});
});
