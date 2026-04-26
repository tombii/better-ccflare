/**
 * Tests for BunSqlAdapter.withBusyRetry (exercised through public methods).
 *
 * withBusyRetry is private, but it is called by query(), get(), run(), and
 * runWithChanges() for every SQLite operation.  We simulate SQLITE_BUSY by
 * replacing the internal sqliteDb methods with stubs that throw once before
 * succeeding, using `(adapter as any).sqliteDb` to reach the private field.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../bun-sql-adapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBusyError(): Error {
	return Object.assign(new Error("database is locked"), {
		code: "SQLITE_BUSY",
	});
}

/**
 * Replace a method on the underlying sqliteDb with a stub that throws
 * SQLITE_BUSY on the first call and delegates to the real method thereafter.
 *
 * Returns a cleanup function that restores the original.
 */
function stubBusyOnce(sqliteDb: Database, method: "run" | "query"): () => void {
	const original = sqliteDb[method].bind(sqliteDb);
	let calls = 0;
	// biome-ignore lint/suspicious/noExplicitAny: test stub replacing internal DB method
	(sqliteDb as any)[method] = (...args: any[]) => {
		calls++;
		if (calls === 1) throw makeBusyError();
		// biome-ignore lint/suspicious/noExplicitAny: delegating to real implementation
		return (original as any)(...args);
	};
	return () => {
		// biome-ignore lint/suspicious/noExplicitAny: restoring original method
		(sqliteDb as any)[method] = original;
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BunSqlAdapter withBusyRetry", () => {
	let db: Database;
	let adapter: BunSqlAdapter;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)");
		adapter = new BunSqlAdapter(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("query() retries on SQLITE_BUSY", () => {
		it("returns result on second attempt after one SQLITE_BUSY", async () => {
			db.run("INSERT INTO t (id, val) VALUES (1, 'hello')");

			const sqliteDb = (adapter as any).sqliteDb as Database;
			const restore = stubBusyOnce(sqliteDb, "query");
			try {
				const rows = await adapter.query<{ id: number; val: string }>(
					"SELECT id, val FROM t",
				);
				expect(rows).toHaveLength(1);
				expect(rows[0].val).toBe("hello");
			} finally {
				restore();
			}
		});
	});

	describe("get() retries on SQLITE_BUSY", () => {
		it("returns the row on second attempt after one SQLITE_BUSY", async () => {
			db.run("INSERT INTO t (id, val) VALUES (2, 'world')");

			const sqliteDb = (adapter as any).sqliteDb as Database;
			const restore = stubBusyOnce(sqliteDb, "query");
			try {
				const row = await adapter.get<{ id: number; val: string }>(
					"SELECT id, val FROM t WHERE id = ?",
					[2],
				);
				expect(row).not.toBeNull();
				expect(row?.val).toBe("world");
			} finally {
				restore();
			}
		});
	});

	describe("run() retries on SQLITE_BUSY", () => {
		it("completes successfully on second attempt after one SQLITE_BUSY", async () => {
			const sqliteDb = (adapter as any).sqliteDb as Database;
			const restore = stubBusyOnce(sqliteDb, "run");
			try {
				await adapter.run("INSERT INTO t (id, val) VALUES (?, ?)", [
					3,
					"retry-run",
				]);
				const row = db.query("SELECT val FROM t WHERE id = 3").get() as {
					val: string;
				} | null;
				expect(row?.val).toBe("retry-run");
			} finally {
				restore();
			}
		});
	});

	describe("runWithChanges() retries on SQLITE_BUSY", () => {
		it("returns affected-row count on second attempt after one SQLITE_BUSY", async () => {
			db.run("INSERT INTO t (id, val) VALUES (4, 'before')");

			const sqliteDb = (adapter as any).sqliteDb as Database;
			const restore = stubBusyOnce(sqliteDb, "run");
			try {
				const changes = await adapter.runWithChanges(
					"UPDATE t SET val = ? WHERE id = ?",
					["after", 4],
				);
				expect(changes).toBe(1);
			} finally {
				restore();
			}
		});
	});

	describe("non-SQLITE_BUSY errors are not retried", () => {
		it("propagates a non-busy error immediately without retrying", async () => {
			// Inject an error whose code is NOT SQLITE_BUSY
			const sqliteDb = (adapter as any).sqliteDb as Database;
			const original = sqliteDb.query.bind(sqliteDb);
			let calls = 0;
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			(sqliteDb as any).query = (...args: any[]) => {
				calls++;
				throw Object.assign(new Error("disk I/O error"), {
					code: "SQLITE_IOERR",
				});
				// biome-ignore lint/correctness/noUnreachable: intentional unreachable for type
				return (original as any)(...args);
			};

			try {
				await expect(adapter.query("SELECT id FROM t")).rejects.toThrow(
					"disk I/O error",
				);
				// Should have thrown immediately — only one call
				expect(calls).toBe(1);
			} finally {
				// biome-ignore lint/suspicious/noExplicitAny: restoring original
				(sqliteDb as any).query = original;
			}
		});
	});

	describe("SQLITE_BUSY past deadline is propagated", () => {
		it("throws SQLITE_BUSY when Date.now() is already past the retry deadline", async () => {
			const sqliteDb = (adapter as any).sqliteDb as Database;
			const originalQuery = sqliteDb.query.bind(sqliteDb);
			const originalDateNow = Date.now;

			// Make every query call throw SQLITE_BUSY
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			(sqliteDb as any).query = (..._args: any[]) => {
				throw makeBusyError();
			};
			// Make the deadline already expired by putting Date.now far in the future
			// relative to the deadline check: deadline = Date.now() + 10min, so if
			// Date.now() returns a value 11min ahead on the *second* check, the retry
			// is skipped.
			let callCount = 0;
			Date.now = () => {
				callCount++;
				// First call (setting deadline): return real time.
				// Subsequent calls (deadline check): return real time + 11 minutes.
				return callCount === 1
					? originalDateNow()
					: originalDateNow() + 11 * 60 * 1000;
			};

			try {
				await expect(adapter.query("SELECT id FROM t")).rejects.toMatchObject({
					code: "SQLITE_BUSY",
				});
			} finally {
				// biome-ignore lint/suspicious/noExplicitAny: restoring original
				(sqliteDb as any).query = originalQuery;
				Date.now = originalDateNow;
			}
		});
	});
});
