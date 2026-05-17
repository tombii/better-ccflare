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
			pause_reason TEXT,
			consecutive_rate_limits INTEGER DEFAULT 0
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
	consecutive_rate_limits: number | null;
}

function getAudit(db: Database, id: string): RawRateLimitAudit {
	return db
		.query<RawRateLimitAudit, [string]>(
			"SELECT rate_limited_until, rate_limited_reason, rate_limited_at, consecutive_rate_limits FROM accounts WHERE id = ?",
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

	describe("consecutive_rate_limits counter", () => {
		it("returns 1 and persists counter=1 on first call", async () => {
			insertAccount(db, "acc-counter-1");
			const until = Date.now() + 30 * 1000;

			const newCount = await repo.setRateLimited(
				"acc-counter-1",
				until,
				"upstream_429_with_reset",
			);

			expect(newCount).toBe(1);
			const row = getAudit(db, "acc-counter-1");
			expect(row.consecutive_rate_limits).toBe(1);
		});

		it("returns 2 and persists counter=2 on second call", async () => {
			insertAccount(db, "acc-counter-2");
			const until = Date.now() + 30 * 1000;

			const first = await repo.setRateLimited(
				"acc-counter-2",
				until,
				"upstream_429_with_reset",
			);
			const second = await repo.setRateLimited(
				"acc-counter-2",
				until,
				"upstream_429_with_reset",
			);

			expect(first).toBe(1);
			expect(second).toBe(2);
			const row = getAudit(db, "acc-counter-2");
			expect(row.consecutive_rate_limits).toBe(2);
		});

		it("increments correctly across many sequential calls", async () => {
			insertAccount(db, "acc-counter-3");
			const until = Date.now() + 30 * 1000;

			for (let i = 1; i <= 5; i++) {
				const count = await repo.setRateLimited(
					"acc-counter-3",
					until,
					"upstream_429_with_reset",
				);
				expect(count).toBe(i);
			}

			const row = getAudit(db, "acc-counter-3");
			expect(row.consecutive_rate_limits).toBe(5);
		});

		it("two parallel calls result in counter=2 (atomic increment at SQL level)", async () => {
			insertAccount(db, "acc-parallel");
			const until = Date.now() + 30 * 1000;

			const results = await Promise.all([
				repo.setRateLimited("acc-parallel", until, "upstream_429_with_reset"),
				repo.setRateLimited("acc-parallel", until, "upstream_429_with_reset"),
			]);

			// Counter in DB must reflect both increments — this is the critical
			// invariant. If the UPDATE used `= 1` instead of `+1`, this would be 1.
			const row = getAudit(db, "acc-parallel");
			expect(row.consecutive_rate_limits).toBe(2);

			// At least one of the returned values must equal the final counter,
			// proving that callers see a real post-UPDATE snapshot. Under
			// concurrent execution the second SELECT may observe the same value
			// as the first if both SELECTs land after both UPDATEs, which is
			// acceptable per the plan's "may be one tier short" caveat.
			expect(results.length).toBe(2);
			expect(Math.max(...results)).toBe(2);
			expect(results.every((v) => v >= 1 && v <= 2)).toBe(true);
		});
	});

	describe("resetConsecutiveRateLimits", () => {
		it("zeros the counter", async () => {
			insertAccount(db, "acc-reset-1");
			const until = Date.now() + 30 * 1000;

			await repo.setRateLimited(
				"acc-reset-1",
				until,
				"upstream_429_with_reset",
			);
			await repo.setRateLimited(
				"acc-reset-1",
				until,
				"upstream_429_with_reset",
			);
			expect(getAudit(db, "acc-reset-1").consecutive_rate_limits).toBe(2);

			await repo.resetConsecutiveRateLimits("acc-reset-1");

			expect(getAudit(db, "acc-reset-1").consecutive_rate_limits).toBe(0);
		});

		it("nulls rate_limited_at", async () => {
			insertAccount(db, "acc-reset-2");
			const until = Date.now() + 30 * 1000;

			await repo.setRateLimited(
				"acc-reset-2",
				until,
				"upstream_429_with_reset",
			);
			expect(getAudit(db, "acc-reset-2").rate_limited_at).not.toBeNull();

			await repo.resetConsecutiveRateLimits("acc-reset-2");

			expect(getAudit(db, "acc-reset-2").rate_limited_at).toBeNull();
		});

		it("does not touch rate_limited_until or rate_limited_reason", async () => {
			insertAccount(db, "acc-reset-3");
			const until = Date.now() + 30 * 1000;

			await repo.setRateLimited(
				"acc-reset-3",
				until,
				"upstream_429_with_reset",
			);
			await repo.resetConsecutiveRateLimits("acc-reset-3");

			const row = getAudit(db, "acc-reset-3");
			expect(row.rate_limited_until).toBe(until);
			expect(row.rate_limited_reason).toBe("upstream_429_with_reset");
		});
	});
});
