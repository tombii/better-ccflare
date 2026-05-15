import { afterEach, beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal DatabaseOperations stand-in exposing only the methods under test.
// We construct with an in-memory SQLite DB so no file I/O is needed.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

function tempDbPath(): string {
	return join(tmpdir(), `test-integrity-${randomBytes(6).toString("hex")}.db`);
}

// ---------------------------------------------------------------------------
// Tests: integrity status cache (no real DB needed)
// ---------------------------------------------------------------------------

describe("DatabaseOperations.getIntegrityStatus / recordIntegrityResult", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	it("returns unchecked status on fresh instance", () => {
		const s = dbOps.getIntegrityStatus();
		expect(s.status).toBe("unchecked");
		expect(s.runningKind).toBeNull();
		expect(s.lastCheckAt).toBeNull();
		expect(s.lastError).toBeNull();
		expect(s.lastQuickCheckAt).toBeNull();
		expect(s.lastQuickResult).toBeNull();
		expect(s.lastFullCheckAt).toBeNull();
		expect(s.lastFullResult).toBeNull();
	});

	it("reflects ok status after recording a quick ok result", () => {
		const before = Date.now();
		dbOps.recordIntegrityResult("quick", "ok");
		const after = Date.now();

		const s = dbOps.getIntegrityStatus();
		expect(s.status).toBe("ok");
		expect(s.lastError).toBeNull();
		expect(s.lastQuickResult).toBe("ok");
		expect(s.lastQuickCheckAt).toBeGreaterThanOrEqual(before);
		expect(s.lastQuickCheckAt).toBeLessThanOrEqual(after);
	});

	it("reflects corrupt status with error message after a corrupt result", () => {
		dbOps.recordIntegrityResult(
			"quick",
			"corrupt",
			"Page 42 has wrong btree type",
		);

		const s = dbOps.getIntegrityStatus();
		expect(s.status).toBe("corrupt");
		expect(s.lastError).toBe("Page 42 has wrong btree type");
		expect(s.lastQuickResult).toBe("corrupt");
	});

	it("clears corrupt after a quick ok when the corrupt was also a quick result", () => {
		dbOps.recordIntegrityResult("quick", "corrupt", "some quick error");
		dbOps.recordIntegrityResult("quick", "ok");

		const s = dbOps.getIntegrityStatus();
		expect(s.status).toBe("ok");
		expect(s.lastError).toBeNull();
	});

	it("STICKY: a quick ok does NOT clear a full corrupt", () => {
		// Full check finds index/table inconsistency that quick_check can't see.
		dbOps.recordIntegrityResult("full", "corrupt", "index has missing entry");
		// Six hours later, the quick check passes — that does NOT mean the
		// full corruption is gone. The collapsed status must stay corrupt.
		dbOps.recordIntegrityResult("quick", "ok");

		const s = dbOps.getIntegrityStatus();
		expect(s.status).toBe("corrupt");
		expect(s.lastFullResult).toBe("corrupt");
		expect(s.lastQuickResult).toBe("ok");
		expect(s.lastError).toBe("index has missing entry");
	});

	it("a subsequent full ok clears full-check corruption", () => {
		dbOps.recordIntegrityResult("full", "corrupt", "some error");
		dbOps.recordIntegrityResult("full", "ok");

		const s = dbOps.getIntegrityStatus();
		expect(s.status).toBe("ok");
		expect(s.lastFullResult).toBe("ok");
		expect(s.lastError).toBeNull();
	});

	it("runningKind reflects the in-flight probe", () => {
		const claimed = dbOps.markIntegrityCheckRunning("full");
		expect(claimed).toBe(true);
		const mid = dbOps.getIntegrityStatus();
		expect(mid.status).toBe("running");
		expect(mid.runningKind).toBe("full");

		dbOps.recordIntegrityResult("full", "ok");
		const done = dbOps.getIntegrityStatus();
		expect(done.status).toBe("ok");
		expect(done.runningKind).toBeNull();
	});

	it("markIntegrityCheckRunning refuses while another probe is running", () => {
		expect(dbOps.markIntegrityCheckRunning("quick")).toBe(true);
		expect(dbOps.markIntegrityCheckRunning("full")).toBe(false);
		expect(dbOps.markIntegrityCheckRunning("quick")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tests: runQuickIntegrityCheck / runFullIntegrityCheck (SQLite mode)
// ---------------------------------------------------------------------------

describe("DatabaseOperations integrity PRAgMA checks", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	it("runQuickIntegrityCheck returns 'ok' on a valid database", async () => {
		const result = await dbOps.runQuickIntegrityCheck();
		expect(result).toBe("ok");
	});

	it("runFullIntegrityCheck returns 'ok' on a valid database", async () => {
		const result = await dbOps.runFullIntegrityCheck();
		expect(result).toBe("ok");
	});

	it("runQuickIntegrityCheck returns a string", async () => {
		const result = await dbOps.runQuickIntegrityCheck();
		expect(typeof result).toBe("string");
	});

	it("runFullIntegrityCheck returns a string", async () => {
		const result = await dbOps.runFullIntegrityCheck();
		expect(typeof result).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// Tests: getStorageMetrics
// ---------------------------------------------------------------------------

describe("DatabaseOperations.getStorageMetrics", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath());
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	it("returns an object with all expected keys", async () => {
		const m = await dbOps.getStorageMetrics();
		expect(m).toHaveProperty("dbBytes");
		expect(m).toHaveProperty("walBytes");
		expect(m).toHaveProperty("orphanPages");
		expect(m).toHaveProperty("lastRetentionSweepAt");
		expect(m).toHaveProperty("nullAccountRows");
	});

	it("dbBytes is a positive number for an on-disk database", async () => {
		const m = await dbOps.getStorageMetrics();
		expect(typeof m.dbBytes).toBe("number");
		expect(m.dbBytes).toBeGreaterThan(0);
	});

	it("walBytes is a non-negative number", async () => {
		const m = await dbOps.getStorageMetrics();
		expect(typeof m.walBytes).toBe("number");
		expect(m.walBytes).toBeGreaterThanOrEqual(0);
	});

	it("orphanPages is a non-negative integer", async () => {
		const m = await dbOps.getStorageMetrics();
		expect(typeof m.orphanPages).toBe("number");
		expect(m.orphanPages).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(m.orphanPages)).toBe(true);
	});

	it("lastRetentionSweepAt is null when no data-retention strategy exists", async () => {
		const m = await dbOps.getStorageMetrics();
		expect(m.lastRetentionSweepAt).toBeNull();
	});

	it("nullAccountRows is 0 on an empty requests table", async () => {
		const m = await dbOps.getStorageMetrics();
		expect(m.nullAccountRows).toBe(0);
	});

	it("nullAccountRows counts only rows with NULL account_used within 24h", async () => {
		// Insert a recent request with NULL account_used
		const adapter = dbOps.getAdapter();
		const now = Date.now();
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, error_message, response_time_ms, failover_attempts)
			 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
			[`null-acct-${now}`, now],
		);

		const m = await dbOps.getStorageMetrics();
		expect(m.nullAccountRows).toBeGreaterThanOrEqual(1);
	});

	it("nullAccountRows excludes rows older than 24h", async () => {
		const adapter = dbOps.getAdapter();
		const old = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, error_message, response_time_ms, failover_attempts)
			 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
			[`old-null-acct-${old}`, old],
		);

		const m = await dbOps.getStorageMetrics();
		expect(m.nullAccountRows).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: generateRecoveryInstructions
// ---------------------------------------------------------------------------

describe("DatabaseOperations.generateRecoveryInstructions", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;

	beforeEach(() => {
		dbPath = tempDbPath();
		dbOps = new DatabaseOperations(dbPath);
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	it("returns a non-empty string", () => {
		const instructions = dbOps.generateRecoveryInstructions();
		expect(typeof instructions).toBe("string");
		expect(instructions.length).toBeGreaterThan(0);
	});

	it("contains the database file path", () => {
		const instructions = dbOps.generateRecoveryInstructions();
		expect(instructions).toContain(dbPath);
	});

	it("contains key recovery step headings", () => {
		const instructions = dbOps.generateRecoveryInstructions();
		expect(instructions).toContain("STOP THE SERVER");
		expect(instructions).toContain("BACKUP CORRUPTED DATABASE");
	});

	it("contains bun start instruction", () => {
		const instructions = dbOps.generateRecoveryInstructions();
		expect(instructions).toContain("bun start");
	});
});
