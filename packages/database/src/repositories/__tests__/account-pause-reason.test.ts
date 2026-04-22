/**
 * Tests for AccountRepository pause/resume with pause_reason (issue #139).
 *
 * Verifies that:
 *  - pause(id)                     sets paused=1, pause_reason='manual'
 *  - pause(id, 'failure_threshold') sets paused=1, pause_reason='failure_threshold'
 *  - pause(id, 'overage')           sets paused=1, pause_reason='overage'
 *  - resume(id)                    sets paused=0, pause_reason=NULL
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
// Without this the enum is undefined when strategy.ts runs. Same pattern as stats-session-cost.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	// Minimal schema — only the columns AccountRepository touches
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT DEFAULT '',
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			priority INTEGER DEFAULT 0,
			auto_fallback_enabled INTEGER DEFAULT 0,
			auto_refresh_enabled INTEGER DEFAULT 0,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			model_mappings TEXT,
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT,
			pause_reason TEXT
		)
	`);

	const adapter = new BunSqlAdapter(db);
	const repo = new AccountRepository(adapter);
	return { db, repo };
}

function insertAccount(db: Database, id: string, paused = 0): void {
	db.run(
		`INSERT INTO accounts (id, name, created_at, paused) VALUES (?, ?, ?, ?)`,
		[id, id, Date.now(), paused],
	);
}

interface RawAccount {
	paused: number;
	pause_reason: string | null;
}

function getAccount(db: Database, id: string): RawAccount {
	return db
		.query<RawAccount, [string]>(
			"SELECT paused, pause_reason FROM accounts WHERE id = ?",
		)
		.get(id) as RawAccount;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AccountRepository — pause / resume with pause_reason", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	describe("pause(id) — default reason", () => {
		it("sets paused=1 and pause_reason='manual' by default", async () => {
			insertAccount(db, "acc-1");

			await repo.pause("acc-1");

			const row = getAccount(db, "acc-1");
			expect(row.paused).toBe(1);
			expect(row.pause_reason).toBe("manual");
		});
	});

	describe("pause(id, 'manual')", () => {
		it("sets paused=1 and pause_reason='manual' when reason is explicit", async () => {
			insertAccount(db, "acc-2");

			await repo.pause("acc-2", "manual");

			const row = getAccount(db, "acc-2");
			expect(row.paused).toBe(1);
			expect(row.pause_reason).toBe("manual");
		});
	});

	describe("pause(id, 'failure_threshold')", () => {
		it("sets paused=1 and pause_reason='failure_threshold'", async () => {
			insertAccount(db, "acc-3");

			await repo.pause("acc-3", "failure_threshold");

			const row = getAccount(db, "acc-3");
			expect(row.paused).toBe(1);
			expect(row.pause_reason).toBe("failure_threshold");
		});
	});

	describe("pause(id, 'overage')", () => {
		it("sets paused=1 and pause_reason='overage'", async () => {
			insertAccount(db, "acc-4");

			await repo.pause("acc-4", "overage");

			const row = getAccount(db, "acc-4");
			expect(row.paused).toBe(1);
			expect(row.pause_reason).toBe("overage");
		});
	});

	describe("resume(id)", () => {
		it("sets paused=0 and clears pause_reason to NULL", async () => {
			insertAccount(db, "acc-5", 1);
			db.run("UPDATE accounts SET pause_reason = 'manual' WHERE id = 'acc-5'");

			await repo.resume("acc-5");

			const row = getAccount(db, "acc-5");
			expect(row.paused).toBe(0);
			expect(row.pause_reason).toBeNull();
		});

		it("clears pause_reason=NULL for an overage-paused account", async () => {
			insertAccount(db, "acc-6", 1);
			db.run("UPDATE accounts SET pause_reason = 'overage' WHERE id = 'acc-6'");

			await repo.resume("acc-6");

			const row = getAccount(db, "acc-6");
			expect(row.paused).toBe(0);
			expect(row.pause_reason).toBeNull();
		});

		it("clears pause_reason=NULL for a failure_threshold-paused account", async () => {
			insertAccount(db, "acc-7", 1);
			db.run(
				"UPDATE accounts SET pause_reason = 'failure_threshold' WHERE id = 'acc-7'",
			);

			await repo.resume("acc-7");

			const row = getAccount(db, "acc-7");
			expect(row.paused).toBe(0);
			expect(row.pause_reason).toBeNull();
		});
	});
});
