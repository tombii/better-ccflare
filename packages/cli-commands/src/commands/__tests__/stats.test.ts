/**
 * Tests for clearRequestHistory (packages/cli-commands/src/commands/stats.ts).
 *
 * The function now takes (dbOps, config) and returns
 * { removedRequests, removedPayloads } — not the old { count } shape.
 */
import { describe, expect, it, mock } from "bun:test";
import { clearRequestHistory, compactDatabase } from "../stats";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeConfig(payloadDays = 3, requestDays = 90) {
	return {
		getDataRetentionDays: () => payloadDays,
		getRequestRetentionDays: () => requestDays,
	} as unknown as import("@better-ccflare/config").Config;
}

function makeDbOps(result: {
	removedRequests: number;
	removedPayloads: number;
}) {
	return {
		cleanupOldRequests: mock(async () => result),
	} as unknown as import("@better-ccflare/database").DatabaseOperations;
}

function makeCompactDbOps(
	result: {
		walBusy: number;
		walLog: number;
		walCheckpointed: number;
		vacuumed: boolean;
		walTruncateBusy?: number;
		error?: string;
	},
	dbPath?: string,
) {
	return {
		// Stub `getResolvedDbPath`; when it returns `undefined` the live-
		// service writer-lock probe in `compactDatabase` is skipped (the
		// probe only makes sense for SQLite mode where there's a real
		// filesystem path to lock). Set `dbPath` to a real file to exercise
		// the probe.
		getResolvedDbPath: () => dbPath,
		compact: mock(async () => result),
	} as unknown as import("@better-ccflare/database").DatabaseOperations;
}

const COMPACT_RESULT = {
	walBusy: 0,
	walLog: 12,
	walCheckpointed: 12,
	vacuumed: true,
	walTruncateBusy: 0,
};

const COMPACT_ERROR_RESULT = {
	walBusy: 1,
	walLog: 5,
	walCheckpointed: 2,
	vacuumed: false,
	error: "busy database",
};

// ---------------------------------------------------------------------------
// compactDatabase tests
// ---------------------------------------------------------------------------

describe("compactDatabase", () => {
	it("calls dbOps.compact once", async () => {
		const dbOps = makeCompactDbOps(COMPACT_RESULT);

		await compactDatabase(dbOps);

		expect(dbOps.compact).toHaveBeenCalledTimes(1);
	});

	it("returns wal/vacuum fields from dbOps.compact", async () => {
		const dbOps = makeCompactDbOps(COMPACT_RESULT);

		const result = await compactDatabase(dbOps);

		expect(result.walBusy).toBe(0);
		expect(result.walLog).toBe(12);
		expect(result.walCheckpointed).toBe(12);
		expect(result.vacuumed).toBe(true);
		expect(result.walTruncateBusy).toBe(0);
		expect(result).not.toHaveProperty("error");
	});

	it("returns error payload unchanged when compact fails", async () => {
		const dbOps = makeCompactDbOps(COMPACT_ERROR_RESULT);

		const result = await compactDatabase(dbOps);

		expect(result.vacuumed).toBe(false);
		expect(result.error).toBe("busy database");
		expect(result.walBusy).toBe(1);
	});

	describe("live-service writer-lock guard", () => {
		it("throws (and does NOT call compact) when another process holds the writer lock", async () => {
			// Simulate the running better-ccflare server holding the DB
			// writer lock by opening a second connection and starting a
			// long-running write transaction. The CLI's probe should hit
			// SQLITE_BUSY and refuse before invoking the worker-backed
			// compact path that would otherwise hang the live server.
			const { Database } = await import("bun:sqlite");
			const fs = await import("node:fs");
			const os = await import("node:os");
			const path = await import("node:path");
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "ccflare-compact-guard-"),
			);
			const dbPath = path.join(tmpDir, "test.db");
			const blocker = new Database(dbPath, { create: true });
			try {
				blocker.exec("CREATE TABLE t (id INTEGER)");
				blocker.exec("BEGIN IMMEDIATE");
				try {
					const dbOps = makeCompactDbOps(COMPACT_RESULT, dbPath);
					await expect(compactDatabase(dbOps)).rejects.toThrow(
						/Refusing to compact/,
					);
					expect(dbOps.compact).toHaveBeenCalledTimes(0);
				} finally {
					blocker.exec("ROLLBACK");
				}
			} finally {
				blocker.close();
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("calls compact when the writer lock is free", async () => {
			// Real DB file, nobody else holding the writer lock — probe
			// succeeds, compact runs.
			const { Database } = await import("bun:sqlite");
			const fs = await import("node:fs");
			const os = await import("node:os");
			const path = await import("node:path");
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "ccflare-compact-ok-"),
			);
			const dbPath = path.join(tmpDir, "test.db");
			const initDb = new Database(dbPath, { create: true });
			initDb.exec("CREATE TABLE t (id INTEGER)");
			initDb.close();
			try {
				const dbOps = makeCompactDbOps(COMPACT_RESULT, dbPath);
				const result = await compactDatabase(dbOps);
				expect(dbOps.compact).toHaveBeenCalledTimes(1);
				expect(result.vacuumed).toBe(true);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});
});

// ---------------------------------------------------------------------------
// clearRequestHistory tests
// ---------------------------------------------------------------------------

describe("clearRequestHistory", () => {
	describe("signature: accepts (dbOps, config)", () => {
		it("calls cleanupOldRequests with payloadMs derived from config.getDataRetentionDays()", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig(3, 90);

			await clearRequestHistory(dbOps, config);

			expect(dbOps.cleanupOldRequests).toHaveBeenCalledTimes(1);
			const [payloadMs] = (dbOps.cleanupOldRequests as ReturnType<typeof mock>)
				.mock.calls[0];
			// 3 days in milliseconds
			expect(payloadMs).toBe(3 * 24 * 60 * 60 * 1000);
		});

		it("calls cleanupOldRequests with requestMs derived from config.getRequestRetentionDays()", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig(3, 90);

			await clearRequestHistory(dbOps, config);

			const [, requestMs] = (
				dbOps.cleanupOldRequests as ReturnType<typeof mock>
			).mock.calls[0];
			// 90 days in milliseconds
			expect(requestMs).toBe(90 * 24 * 60 * 60 * 1000);
		});

		it("passes different payloadDays when config specifies a different value", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig(7, 180);

			await clearRequestHistory(dbOps, config);

			const [payloadMs, requestMs] = (
				dbOps.cleanupOldRequests as ReturnType<typeof mock>
			).mock.calls[0];
			expect(payloadMs).toBe(7 * 24 * 60 * 60 * 1000);
			expect(requestMs).toBe(180 * 24 * 60 * 60 * 1000);
		});
	});

	describe("return value: { removedRequests, removedPayloads }", () => {
		it("returns removedRequests and removedPayloads from dbOps.cleanupOldRequests", async () => {
			const dbOps = makeDbOps({ removedRequests: 42, removedPayloads: 17 });
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			expect(result.removedRequests).toBe(42);
			expect(result.removedPayloads).toBe(17);
		});

		it("returns zero counts when nothing was deleted", async () => {
			const dbOps = makeDbOps({ removedRequests: 0, removedPayloads: 0 });
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			expect(result.removedRequests).toBe(0);
			expect(result.removedPayloads).toBe(0);
		});

		it("does NOT return a { count } field (old signature removed)", async () => {
			const dbOps = makeDbOps({ removedRequests: 5, removedPayloads: 3 });
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			// Confirm old shape is absent
			expect(result).not.toHaveProperty("count");
		});

		it("propagates large deletion counts accurately", async () => {
			const dbOps = makeDbOps({
				removedRequests: 100_000,
				removedPayloads: 50_000,
			});
			const config = makeConfig();

			const result = await clearRequestHistory(dbOps, config);

			expect(result.removedRequests).toBe(100_000);
			expect(result.removedPayloads).toBe(50_000);
		});
	});
});
