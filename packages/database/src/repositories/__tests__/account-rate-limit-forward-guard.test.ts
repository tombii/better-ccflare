import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
// Without this the enum is undefined when strategy.ts runs. Same pattern as
// account-rate-limit-audit.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	// Minimal schema — includes consecutive_rate_limits, which
	// markAccountRateLimited SELECTs back after every write.
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
			consecutive_rate_limits INTEGER DEFAULT 0,
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
}

function getAudit(db: Database, id: string): RawRateLimitAudit {
	return db
		.query<RawRateLimitAudit, [string]>(
			"SELECT rate_limited_until, rate_limited_reason FROM accounts WHERE id = ?",
		)
		.get(id) as RawRateLimitAudit;
}

describe("AccountRepository.markAccountRateLimited — 529 forward guard (delta-codex-1 / delta-internal-3)", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("applies an equal-expiry 529 write instead of silently dropping it (last writer wins on a tie, matching the in-process guard's strict '>' rejection)", async () => {
		insertAccount(db, "acc-1");
		const X = Date.now() + 5 * 60 * 1000;

		// A 429 landed first and set the account's active cooldown to X.
		await repo.markAccountRateLimited(
			"acc-1",
			X,
			"upstream_429_with_reset",
			true,
		);

		// A 529-with-reset arrives whose computed cooldownUntil happens to equal
		// X exactly (plausible: both can derive from the same upstream reset
		// header within the same request window). The in-process forward guard
		// in rate-limit-cooldown.ts only rejects a STRICTLY longer existing
		// cooldown (`>`), so it lets this equal-expiry write proceed in memory —
		// the DB-side guard must agree, or the DB silently keeps the stale 429
		// reason while memory has already moved on to the 529 reason.
		await repo.markAccountRateLimited(
			"acc-1",
			X,
			"upstream_529_overloaded_with_reset",
			false,
		);

		const row = getAudit(db, "acc-1");
		expect(row.rate_limited_reason).toBe("upstream_529_overloaded_with_reset");
		expect(row.rate_limited_until).toBe(X);
	});

	it("rejects a 529 write whose cooldown is strictly shorter than the currently active one", async () => {
		insertAccount(db, "acc-2");
		const X = Date.now() + 5 * 60 * 1000;
		await repo.markAccountRateLimited(
			"acc-2",
			X,
			"upstream_429_with_reset",
			true,
		);

		const shorter = X - 60_000;
		await repo.markAccountRateLimited(
			"acc-2",
			shorter,
			"upstream_529_overloaded_no_reset",
			false,
		);

		// The longer, already-active 429 bench must survive untouched.
		const row = getAudit(db, "acc-2");
		expect(row.rate_limited_reason).toBe("upstream_429_with_reset");
		expect(row.rate_limited_until).toBe(X);
	});

	it("applies a 529 write when the account currently has no cooldown at all", async () => {
		insertAccount(db, "acc-3");
		const until = Date.now() + 10_000;

		await repo.markAccountRateLimited(
			"acc-3",
			until,
			"upstream_529_overloaded_no_reset",
			false,
		);

		const row = getAudit(db, "acc-3");
		expect(row.rate_limited_reason).toBe("upstream_529_overloaded_no_reset");
		expect(row.rate_limited_until).toBe(until);
	});
});
