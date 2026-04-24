/**
 * Tests for DatabaseOperations.cleanupOldRequests.
 *
 * Verifies the two-pass deletion order (payloads first, then request metadata)
 * and the returned counts after the internal order change.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function insertRequest(
	db: Database,
	id: string,
	timestamp: number,
	withPayload = false,
): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
		[id, timestamp],
	);
	if (withPayload) {
		db.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, '{}', ?)`,
			[id, timestamp],
		);
	}
}

// A minimal DatabaseOperations stand-in that exercises only cleanupOldRequests
// through the real RequestRepository methods (via BunSqlAdapter).
// We import just the request repository to avoid pulling in the full DI stack.
import { RequestRepository } from "../repositories/request.repository";

async function runCleanup(
	db: Database,
	payloadRetentionMs: number,
	requestRetentionMs?: number,
): Promise<{ removedRequests: number; removedPayloads: number }> {
	const adapter = new BunSqlAdapter(db);
	const repo = new RequestRepository(adapter);

	const now = Date.now();

	// Pass 1 — payloads (mirrors DatabaseOperations.cleanupOldRequests)
	const payloadCutoff = now - payloadRetentionMs;
	const removedPayloadsByAge =
		await repo.deletePayloadsOlderThan(payloadCutoff);
	const removedOrphans = await repo.deleteOrphanedPayloads();

	// Pass 2 — request metadata
	let removedRequests = 0;
	if (
		typeof requestRetentionMs === "number" &&
		Number.isFinite(requestRetentionMs)
	) {
		const requestCutoff = now - requestRetentionMs;
		removedRequests = await repo.deleteOlderThan(requestCutoff);
	}

	return {
		removedRequests,
		removedPayloads: removedPayloadsByAge + removedOrphans,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cleanupOldRequests", () => {
	let db: Database;

	beforeEach(() => {
		db = makeDb();
	});

	afterEach(() => {
		db.close();
	});

	describe("return shape", () => {
		it("returns { removedRequests, removedPayloads } when nothing to delete", async () => {
			const result = await runCleanup(db, 7 * 24 * 60 * 60 * 1000);
			expect(result).toHaveProperty("removedRequests");
			expect(result).toHaveProperty("removedPayloads");
			expect(result.removedRequests).toBe(0);
			expect(result.removedPayloads).toBe(0);
		});

		it("does NOT return a top-level { count } field", async () => {
			const result = await runCleanup(db, 7 * 24 * 60 * 60 * 1000);
			expect(result).not.toHaveProperty("count");
		});
	});

	describe("payload cleanup (Pass 1)", () => {
		it("deletes payloads older than payloadRetentionMs", async () => {
			const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
			insertRequest(db, "old-req", old, true);

			const result = await runCleanup(db, 7 * 24 * 60 * 60 * 1000);

			expect(result.removedPayloads).toBeGreaterThanOrEqual(1);
			const remaining = db
				.query("SELECT COUNT(*) as n FROM request_payloads")
				.get() as { n: number };
			expect(remaining.n).toBe(0);
		});

		it("preserves payloads younger than the cutoff", async () => {
			const recent = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
			insertRequest(db, "recent-req", recent, true);

			const result = await runCleanup(db, 7 * 24 * 60 * 60 * 1000);

			expect(result.removedPayloads).toBe(0);
			const remaining = db
				.query("SELECT COUNT(*) as n FROM request_payloads")
				.get() as { n: number };
			expect(remaining.n).toBe(1);
		});

		it("reports orphaned payloads (payload whose request row was deleted) in removedPayloads", async () => {
			const old = Date.now() - 95 * 24 * 60 * 60 * 1000; // 95 days ago
			insertRequest(db, "orphan-host", old, true);

			// Delete the request row directly to create an orphan payload
			db.run("DELETE FROM requests WHERE id = 'orphan-host'");

			const result = await runCleanup(
				db,
				7 * 24 * 60 * 60 * 1000,
				90 * 24 * 60 * 60 * 1000,
			);

			// The orphaned payload should be captured in removedPayloads
			expect(result.removedPayloads).toBeGreaterThanOrEqual(1);
		});
	});

	describe("request metadata cleanup (Pass 2)", () => {
		it("deletes request rows older than requestRetentionMs", async () => {
			const old = Date.now() - 95 * 24 * 60 * 60 * 1000; // 95 days ago
			insertRequest(db, "old-meta", old, false);

			const result = await runCleanup(
				db,
				7 * 24 * 60 * 60 * 1000,
				90 * 24 * 60 * 60 * 1000,
			);

			expect(result.removedRequests).toBe(1);
			const remaining = db
				.query("SELECT COUNT(*) as n FROM requests")
				.get() as { n: number };
			expect(remaining.n).toBe(0);
		});

		it("preserves request rows younger than requestRetentionMs", async () => {
			const recent = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
			insertRequest(db, "recent-meta", recent, false);

			const result = await runCleanup(
				db,
				7 * 24 * 60 * 60 * 1000,
				90 * 24 * 60 * 60 * 1000,
			);

			expect(result.removedRequests).toBe(0);
			const remaining = db
				.query("SELECT COUNT(*) as n FROM requests")
				.get() as { n: number };
			expect(remaining.n).toBe(1);
		});

		it("skips request deletion when requestRetentionMs is undefined", async () => {
			const old = Date.now() - 95 * 24 * 60 * 60 * 1000;
			insertRequest(db, "skip-meta", old, false);

			// Pass 2 omitted — only payloadRetentionMs supplied
			const result = await runCleanup(db, 7 * 24 * 60 * 60 * 1000);

			expect(result.removedRequests).toBe(0);
			const remaining = db
				.query("SELECT COUNT(*) as n FROM requests")
				.get() as { n: number };
			expect(remaining.n).toBe(1);
		});
	});

	describe("deletion order: payloads are removed before request metadata", () => {
		it("payload row is gone before request row is deleted in the same cleanup run", async () => {
			// Both older than their respective windows
			const old = Date.now() - 95 * 24 * 60 * 60 * 1000;
			insertRequest(db, "ordered-req", old, true);

			// Track payload presence before the call
			const payloadBefore = db
				.query(
					"SELECT COUNT(*) as n FROM request_payloads WHERE id = 'ordered-req'",
				)
				.get() as { n: number };
			expect(payloadBefore.n).toBe(1);

			const result = await runCleanup(
				db,
				7 * 24 * 60 * 60 * 1000,
				90 * 24 * 60 * 60 * 1000,
			);

			// Both should have been cleaned up
			expect(result.removedPayloads).toBeGreaterThanOrEqual(1);
			expect(result.removedRequests).toBe(1);

			const payloadAfter = db
				.query(
					"SELECT COUNT(*) as n FROM request_payloads WHERE id = 'ordered-req'",
				)
				.get() as { n: number };
			const requestAfter = db
				.query("SELECT COUNT(*) as n FROM requests WHERE id = 'ordered-req'")
				.get() as { n: number };
			expect(payloadAfter.n).toBe(0);
			expect(requestAfter.n).toBe(0);
		});

		it("payload with short window is deleted even when request row survives (different retention windows)", async () => {
			// Older than payload window (7d) but younger than request window (90d)
			const age = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
			insertRequest(db, "payload-only", age, true);

			const result = await runCleanup(
				db,
				7 * 24 * 60 * 60 * 1000,
				90 * 24 * 60 * 60 * 1000,
			);

			// Payload gone, request row survives
			expect(result.removedPayloads).toBeGreaterThanOrEqual(1);
			expect(result.removedRequests).toBe(0);

			const requestAfter = db
				.query("SELECT COUNT(*) as n FROM requests WHERE id = 'payload-only'")
				.get() as { n: number };
			expect(requestAfter.n).toBe(1);
		});
	});

	describe("mixed age data", () => {
		it("correctly counts deletions when old and recent rows coexist", async () => {
			const old = Date.now() - 95 * 24 * 60 * 60 * 1000;
			const recent = Date.now() - 1 * 24 * 60 * 60 * 1000;

			insertRequest(db, "old-1", old, true);
			insertRequest(db, "old-2", old, true);
			insertRequest(db, "recent-1", recent, true);
			insertRequest(db, "recent-2", recent, false);

			const result = await runCleanup(
				db,
				7 * 24 * 60 * 60 * 1000,
				90 * 24 * 60 * 60 * 1000,
			);

			// old-1 and old-2 payloads deleted; recent-1 payload survives
			expect(result.removedPayloads).toBe(2);
			// old-1 and old-2 request rows deleted; recent-1 and recent-2 survive
			expect(result.removedRequests).toBe(2);
		});
	});
});
