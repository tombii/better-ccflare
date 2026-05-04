import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
// Without this the enum is undefined when strategy.ts runs. Same pattern as stats-session-cost.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	// Minimal schema — includes the new audit columns that the migration will add
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
			rate_limited_reason TEXT,
			rate_limited_at INTEGER,
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

function insertAccount(db: Database, id: string): void {
	db.run(`INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)`, [
		id,
		id,
		Date.now(),
	]);
}

interface RawRateLimitAudit {
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limited_at: number | null;
}

function getAudit(db: Database, id: string): RawRateLimitAudit {
	return db
		.query<RawRateLimitAudit, [string]>(
			"SELECT rate_limited_until, rate_limited_reason, rate_limited_at FROM accounts WHERE id = ?",
		)
		.get(id) as RawRateLimitAudit;
}

describe("AccountRepository — setRateLimited with reason audit (issue #178)", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	describe("setRateLimited(id, until, reason)", () => {
		it("stores rate_limited_until when called with a reason", async () => {
			insertAccount(db, "acc-1");
			const until = Date.now() + 5 * 60 * 60 * 1000;

			await repo.setRateLimited("acc-1", until, "upstream_429_with_reset");

			const row = getAudit(db, "acc-1");
			expect(row.rate_limited_until).toBe(until);
		});

		it("stores rate_limited_reason when reason='upstream_429_with_reset'", async () => {
			insertAccount(db, "acc-2");
			const until = Date.now() + 30 * 60 * 1000;

			await repo.setRateLimited("acc-2", until, "upstream_429_with_reset");

			const row = getAudit(db, "acc-2");
			expect(row.rate_limited_reason).toBe("upstream_429_with_reset");
		});

		it("stores rate_limited_reason when reason='upstream_429_no_reset_default_5h'", async () => {
			insertAccount(db, "acc-3");
			const until = Date.now() + 5 * 60 * 60 * 1000;

			await repo.setRateLimited(
				"acc-3",
				until,
				"upstream_429_no_reset_default_5h",
			);

			const row = getAudit(db, "acc-3");
			expect(row.rate_limited_reason).toBe("upstream_429_no_reset_default_5h");
		});

		it("stores rate_limited_reason when reason='model_fallback_429'", async () => {
			insertAccount(db, "acc-4");
			const until = Date.now() + 60 * 60 * 1000;

			await repo.setRateLimited("acc-4", until, "model_fallback_429");

			const row = getAudit(db, "acc-4");
			expect(row.rate_limited_reason).toBe("model_fallback_429");
		});

		it("stores rate_limited_reason when reason='all_models_exhausted_429'", async () => {
			insertAccount(db, "acc-5");
			const until = Date.now() + 60 * 60 * 1000;

			await repo.setRateLimited("acc-5", until, "all_models_exhausted_429");

			const row = getAudit(db, "acc-5");
			expect(row.rate_limited_reason).toBe("all_models_exhausted_429");
		});

		it("stores rate_limited_at approximately equal to Date.now()", async () => {
			insertAccount(db, "acc-6");
			const until = Date.now() + 5 * 60 * 60 * 1000;
			const before = Date.now();

			await repo.setRateLimited("acc-6", until, "upstream_429_with_reset");

			const after = Date.now();
			const row = getAudit(db, "acc-6");
			expect(row.rate_limited_at).not.toBeNull();
			expect(row.rate_limited_at!).toBeGreaterThanOrEqual(before);
			expect(row.rate_limited_at!).toBeLessThanOrEqual(after + 100);
		});

		it("overwrites previous reason when rate-limited again", async () => {
			insertAccount(db, "acc-7");
			const until1 = Date.now() + 30 * 60 * 1000;
			await repo.setRateLimited("acc-7", until1, "upstream_429_with_reset");

			const until2 = Date.now() + 5 * 60 * 60 * 1000;
			await repo.setRateLimited("acc-7", until2, "model_fallback_429");

			const row = getAudit(db, "acc-7");
			expect(row.rate_limited_until).toBe(until2);
			expect(row.rate_limited_reason).toBe("model_fallback_429");
		});
	});
});
