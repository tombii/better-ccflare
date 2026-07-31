/**
 * Tests for StatsRepository.getAccountStats — the no-account bucket.
 *
 * The unauthenticated bucket is produced by a LEFT JOIN against accounts
 * using a COALESCE(a.id, NO_ACCOUNT_ID) trick, so its synthetic id lands in
 * the accountStats row. The follow-up success-rate query used to bind
 * `WHERE account_used IN (...)` against the raw id, which matched nothing
 * under the current NULL encoding and reported 0% success for the bucket.
 *
 * It now uses COALESCE(account_used, NO_ACCOUNT_ID) in both WHERE and
 * GROUP BY so the bucket reports the real success rate. Legacy rows whose
 * account_used is literally 'no_account' (pre-NULL encoding) still match
 * the same bucket — they collapse into the same COALESCE group.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types.
// types/agent.ts runtime-imports core while core/strategy.ts imports types, a
// pre-existing cycle that crashes when types is the first module evaluated.
import "@better-ccflare/core";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { StatsRepository } from "../stats.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function insertRequest(
	db: Database,
	row: {
		id: string;
		timestamp: number;
		account_used: string | null;
		success: boolean;
	},
) {
	db.run(
		"INSERT INTO requests (id, timestamp, method, path, account_used, success) VALUES (?, ?, ?, ?, ?, ?)",
		[row.id, row.timestamp, "POST", "/v1/messages", row.account_used, row.success ? 1 : 0],
	);
}

function insertAccount(
	db: Database,
	row: { id: string; name: string; request_count?: number; total_requests?: number },
) {
	db.run(
		"INSERT INTO accounts (id, name, provider, request_count, total_requests, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		[
			row.id,
			row.name,
			"anthropic",
			row.request_count ?? 0,
			row.total_requests ?? 0,
			Date.now(),
		],
	);
}

describe("StatsRepository.getAccountStats — no-account bucket binding", () => {
	let db: Database;
	let repo: StatsRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new StatsRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("reports the real success rate for the no-account bucket under the NULL encoding", async () => {
		// 3 NULL rows: 2 success, 1 failure → 67% success rate
		insertRequest(db, { id: "n1", timestamp: 1, account_used: null, success: true });
		insertRequest(db, { id: "n2", timestamp: 2, account_used: null, success: true });
		insertRequest(db, { id: "n3", timestamp: 3, account_used: null, success: false });

		const result = await repo.getAccountStats(10, true);

		const noAccount = result.find((r) => r.name === NO_ACCOUNT_ID);
		expect(noAccount).toBeDefined();
		expect(noAccount?.requestCount).toBe(3);
		// 2 of 3 → 67% (rounded)
		expect(noAccount?.successRate).toBe(67);
	});

	it("matches the legacy literal 'no_account' rows in the same bucket", async () => {
		// 4 legacy literal rows: 3 success, 1 failure → 75%
		insertRequest(db, {
			id: "l1",
			timestamp: 1,
			account_used: NO_ACCOUNT_ID,
			success: true,
		});
		insertRequest(db, {
			id: "l2",
			timestamp: 2,
			account_used: NO_ACCOUNT_ID,
			success: true,
		});
		insertRequest(db, {
			id: "l3",
			timestamp: 3,
			account_used: NO_ACCOUNT_ID,
			success: true,
		});
		insertRequest(db, {
			id: "l4",
			timestamp: 4,
			account_used: NO_ACCOUNT_ID,
			success: false,
		});

		const result = await repo.getAccountStats(10, true);

		const noAccount = result.find((r) => r.name === NO_ACCOUNT_ID);
		expect(noAccount).toBeDefined();
		expect(noAccount?.requestCount).toBe(4);
		expect(noAccount?.successRate).toBe(75);
	});

	it("collapses NULL rows and legacy literal rows into a single bucket", async () => {
		// 2 NULL + 2 literal: all 4 successes → 100%
		insertRequest(db, { id: "n1", timestamp: 1, account_used: null, success: true });
		insertRequest(db, { id: "n2", timestamp: 2, account_used: null, success: true });
		insertRequest(db, {
			id: "l1",
			timestamp: 3,
			account_used: NO_ACCOUNT_ID,
			success: true,
		});
		insertRequest(db, {
			id: "l2",
			timestamp: 4,
			account_used: NO_ACCOUNT_ID,
			success: true,
		});

		const result = await repo.getAccountStats(10, true);

		const noAccount = result.find((r) => r.name === NO_ACCOUNT_ID);
		expect(noAccount).toBeDefined();
		expect(noAccount?.requestCount).toBe(4);
		expect(noAccount?.successRate).toBe(100);
	});

	it("computes correct success rates for real accounts alongside the no-account bucket", async () => {
		insertAccount(db, { id: "real-1", name: "acct-real" });

		// Real account: 1 success / 2 total → 50%
		insertRequest(db, {
			id: "r1",
			timestamp: 1,
			account_used: "real-1",
			success: true,
		});
		insertRequest(db, {
			id: "r2",
			timestamp: 2,
			account_used: "real-1",
			success: false,
		});

		// No-account bucket: 2 success / 2 total → 100%
		insertRequest(db, { id: "n1", timestamp: 3, account_used: null, success: true });
		insertRequest(db, { id: "n2", timestamp: 4, account_used: null, success: true });

		const result = await repo.getAccountStats(10, true);

		const noAccount = result.find((r) => r.name === NO_ACCOUNT_ID);
		const real = result.find((r) => r.name === "acct-real");

		expect(noAccount?.successRate).toBe(100);
		expect(noAccount?.requestCount).toBe(2);
		expect(real?.successRate).toBe(50);
		expect(real?.requestCount).toBe(2);
	});

	it("reports 0 success rate when every no-account row failed", async () => {
		insertRequest(db, { id: "n1", timestamp: 1, account_used: null, success: false });
		insertRequest(db, { id: "n2", timestamp: 2, account_used: null, success: false });

		const result = await repo.getAccountStats(10, true);

		const noAccount = result.find((r) => r.name === NO_ACCOUNT_ID);
		expect(noAccount).toBeDefined();
		expect(noAccount?.successRate).toBe(0);
		expect(noAccount?.requestCount).toBe(2);
	});
});
