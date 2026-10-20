/**
 * WAL growth controls on the main SQLite connection:
 *  - `journal_size_limit` (default 64 MiB, `CCFLARE_WAL_SIZE_LIMIT_BYTES`,
 *    `0` leaves SQLite's no-limit default)
 *  - `DatabaseOperations.truncateWal()`: a non-blocking
 *    `wal_checkpoint(TRUNCATE)` that reports busy/locked instead of throwing
 *    or waiting out `busy_timeout`
 *  - `resolveWalTruncateIntervalMinutes()` for the periodic job
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clampTimerIntervalMinutes,
	DatabaseOperations,
	DEFAULT_WAL_SIZE_LIMIT_BYTES,
	DEFAULT_WAL_TRUNCATE_INTERVAL_MINUTES,
	MAX_TIMER_INTERVAL_MINUTES,
	resolveWalSizeLimitBytes,
	resolveWalTruncateIntervalMinutes,
} from "../database-operations";
import { runWalTruncateInWorker } from "../wal-truncate-runner";

function journalSizeLimit(dbOps: DatabaseOperations): number {
	return (
		dbOps.getDatabase().query("PRAGMA journal_size_limit").get() as {
			journal_size_limit: number;
		}
	).journal_size_limit;
}

function busyTimeout(db: Database): number {
	return (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
}

describe("WAL growth controls", () => {
	let tmpDir: string;
	const savedEnv = {
		size: process.env.CCFLARE_WAL_SIZE_LIMIT_BYTES,
		interval: process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES,
	};

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-wal-truncate-"));
		delete process.env.CCFLARE_WAL_SIZE_LIMIT_BYTES;
		delete process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES;
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (savedEnv.size === undefined) {
			delete process.env.CCFLARE_WAL_SIZE_LIMIT_BYTES;
		} else {
			process.env.CCFLARE_WAL_SIZE_LIMIT_BYTES = savedEnv.size;
		}
		if (savedEnv.interval === undefined) {
			delete process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES;
		} else {
			process.env.CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES = savedEnv.interval;
		}
	});

	describe("resolveWalSizeLimitBytes", () => {
		it("defaults to 64 MiB", () => {
			expect(DEFAULT_WAL_SIZE_LIMIT_BYTES).toBe(64 * 1024 * 1024);
			expect(resolveWalSizeLimitBytes(undefined)).toBe(
				DEFAULT_WAL_SIZE_LIMIT_BYTES,
			);
			expect(resolveWalSizeLimitBytes("")).toBe(DEFAULT_WAL_SIZE_LIMIT_BYTES);
		});

		it("accepts a positive integer", () => {
			expect(resolveWalSizeLimitBytes("1048576")).toBe(1048576);
		});

		it("returns undefined for 0 (disabled)", () => {
			expect(resolveWalSizeLimitBytes("0")).toBeUndefined();
		});

		it("falls back to the default on invalid input", () => {
			expect(resolveWalSizeLimitBytes("abc")).toBe(
				DEFAULT_WAL_SIZE_LIMIT_BYTES,
			);
			expect(resolveWalSizeLimitBytes("-5")).toBe(DEFAULT_WAL_SIZE_LIMIT_BYTES);
			expect(resolveWalSizeLimitBytes("1.5")).toBe(
				DEFAULT_WAL_SIZE_LIMIT_BYTES,
			);
		});
	});

	describe("resolveWalTruncateIntervalMinutes", () => {
		it("defaults to 10 minutes", () => {
			expect(DEFAULT_WAL_TRUNCATE_INTERVAL_MINUTES).toBe(10);
			expect(resolveWalTruncateIntervalMinutes(undefined)).toBe(10);
			expect(resolveWalTruncateIntervalMinutes("")).toBe(10);
		});

		it("accepts a positive integer and returns null for 0", () => {
			expect(resolveWalTruncateIntervalMinutes("3")).toBe(3);
			expect(resolveWalTruncateIntervalMinutes("0")).toBeNull();
		});

		it("falls back to the default on invalid input", () => {
			expect(resolveWalTruncateIntervalMinutes("soon")).toBe(10);
			expect(resolveWalTruncateIntervalMinutes("-1")).toBe(10);
		});

		it("clamps intervals that would overflow the timer's 32-bit delay", () => {
			// `minutes * 60 * 1000` above 2^31-1 overflows, and the runtime
			// turns the delay into 1 ms — the job would then run continuously.
			expect(MAX_TIMER_INTERVAL_MINUTES).toBe(35791);
			expect(MAX_TIMER_INTERVAL_MINUTES * 60 * 1000).toBeLessThan(2 ** 31);
			expect(resolveWalTruncateIntervalMinutes("43200")).toBe(
				MAX_TIMER_INTERVAL_MINUTES,
			);
			expect(resolveWalTruncateIntervalMinutes("100000000")).toBe(
				MAX_TIMER_INTERVAL_MINUTES,
			);
			// A value that still fits is passed through unchanged.
			expect(resolveWalTruncateIntervalMinutes("1440")).toBe(1440);
		});
	});

	describe("clampTimerIntervalMinutes", () => {
		it("clamps to the maximum timer delay", () => {
			expect(clampTimerIntervalMinutes(43200)).toBe(MAX_TIMER_INTERVAL_MINUTES);
			expect(clampTimerIntervalMinutes(30)).toBe(30);
		});
	});

	describe("journal_size_limit on the main connection", () => {
		it("is 64 MiB by default", async () => {
			const dbOps = new DatabaseOperations(path.join(tmpDir, "a.db"));
			try {
				expect(journalSizeLimit(dbOps)).toBe(64 * 1024 * 1024);
			} finally {
				await dbOps.close();
			}
		});

		it("follows CCFLARE_WAL_SIZE_LIMIT_BYTES", async () => {
			process.env.CCFLARE_WAL_SIZE_LIMIT_BYTES = "2097152";
			const dbOps = new DatabaseOperations(path.join(tmpDir, "b.db"));
			try {
				expect(journalSizeLimit(dbOps)).toBe(2097152);
			} finally {
				await dbOps.close();
			}
		});

		it("is left at SQLite's default (-1, no limit) when set to 0", async () => {
			process.env.CCFLARE_WAL_SIZE_LIMIT_BYTES = "0";
			const dbOps = new DatabaseOperations(path.join(tmpDir, "c.db"));
			try {
				expect(journalSizeLimit(dbOps)).toBe(-1);
			} finally {
				await dbOps.close();
			}
		});

		it("can be set through DatabaseConfig", async () => {
			const dbOps = new DatabaseOperations(path.join(tmpDir, "d.db"), {
				journalSizeLimitBytes: 4096,
			});
			try {
				expect(journalSizeLimit(dbOps)).toBe(4096);
			} finally {
				await dbOps.close();
			}
		});

		it("treats a DatabaseConfig value of 0 as 'no limit', like the env var", async () => {
			// `0` must mean the same thing through both spellings. SQLite's own
			// `journal_size_limit = 0` means "truncate the WAL to zero bytes on
			// every reset", which is not what the env var's 0 means — so the
			// PRAGMA is skipped instead of being issued.
			const dbOps = new DatabaseOperations(path.join(tmpDir, "e.db"), {
				journalSizeLimitBytes: 0,
			});
			try {
				expect(journalSizeLimit(dbOps)).toBe(-1);
			} finally {
				await dbOps.close();
			}
		});
	});

	describe("truncateWal", () => {
		it("checkpoints and truncates the -wal file to zero bytes", async () => {
			const dbPath = path.join(tmpDir, "t.db");
			const dbOps = new DatabaseOperations(dbPath);
			try {
				const db = dbOps.getDatabase();
				// Stop auto-checkpoints so the WAL is guaranteed to have grown.
				db.run("PRAGMA wal_autocheckpoint = 0");
				db.run("CREATE TABLE filler (v TEXT)");
				for (let i = 0; i < 200; i++) {
					db.run("INSERT INTO filler VALUES (?)", ["x".repeat(2000)]);
				}
				expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(100_000);

				const result = await dbOps.truncateWal();
				expect(result).not.toBeNull();
				expect(result?.busy).toBe(false);
				expect(result?.error).toBeUndefined();
				expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
				// Data is still there after the checkpoint.
				expect(
					(db.query("SELECT count(*) AS n FROM filler").get() as { n: number })
						.n,
				).toBe(200);
			} finally {
				await dbOps.close();
			}
		});

		it("does not block the event loop while the checkpoint runs", async () => {
			// The checkpoint runs in a worker thread: a synchronous call on the
			// main connection would freeze the event loop while SQLite copies
			// the WAL backlog into the database file.
			const dbPath = path.join(tmpDir, "async.db");
			const dbOps = new DatabaseOperations(dbPath);
			try {
				const db = dbOps.getDatabase();
				db.run("PRAGMA wal_autocheckpoint = 0");
				db.run("CREATE TABLE filler (v TEXT)");
				for (let i = 0; i < 200; i++) {
					db.run("INSERT INTO filler VALUES (?)", ["x".repeat(2000)]);
				}

				let ticked = false;
				const timer = setTimeout(() => {
					ticked = true;
				}, 0);
				const result = await dbOps.truncateWal();
				clearTimeout(timer);
				expect(result?.busy).toBe(false);
				// The event loop got a chance to run while the checkpoint was
				// in flight (the timer fired before the await resolved).
				expect(ticked).toBe(true);
			} finally {
				await dbOps.close();
			}
		});

		it("reports busy while a reader holds a snapshot, and leaves the main connection's busy_timeout alone", async () => {
			const dbPath = path.join(tmpDir, "busy.db");
			const dbOps = new DatabaseOperations(dbPath, { busyTimeoutMs: 10_000 });
			const reader = new Database(dbPath, { readonly: true });
			try {
				const db = dbOps.getDatabase();
				db.run("CREATE TABLE w (v TEXT)");
				db.run("INSERT INTO w VALUES ('a')");
				reader.exec("BEGIN");
				reader.query("SELECT count(*) FROM w").get();
				db.run("INSERT INTO w VALUES ('b')");

				const result = await dbOps.truncateWal();
				expect(result).not.toBeNull();
				expect(result?.busy).toBe(true);
				// The checkpoint runs on the worker's own connection, so the
				// main connection's busy_timeout is never touched.
				expect(busyTimeout(db)).toBe(10_000);

				reader.exec("COMMIT");
				const after = await dbOps.truncateWal();
				expect(after?.busy).toBe(false);
				expect(busyTimeout(db)).toBe(10_000);
			} finally {
				reader.close();
				await dbOps.close();
			}
		});

		it("reports a failure as an error instead of throwing", async () => {
			// A checkpoint against a path that isn't a database fails inside
			// the worker. The failure must come back as `error` (not as a
			// "busy" result), so the caller can log it above debug level.
			const response = await runWalTruncateInWorker(
				path.join(tmpDir, "does-not-exist", "x.db"),
			);
			expect(response.ok).toBe(false);
			if (!response.ok) {
				expect(response.busy).toBe(false);
				expect(response.error.length).toBeGreaterThan(0);
			}
		});
	});
});
