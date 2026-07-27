import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
// Without this the enum is undefined when strategy.ts runs. Same pattern as
// account-rate-limit-audit.test.ts.
import "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
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
		const result = await repo.markAccountRateLimited(
			"acc-1",
			X,
			"upstream_529_overloaded_with_reset",
			false,
		);

		expect(result.applied).toBe(true);
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
		const result = await repo.markAccountRateLimited(
			"acc-2",
			shorter,
			"upstream_529_overloaded_no_reset",
			false,
		);

		// delta2-3: the guard's rejection must be visible to the caller, not
		// just to the DB row — the caller (applyRateLimitCooldown) uses this to
		// decide whether to log `cooldown_applied` or `cooldown_skipped_longer_active`.
		expect(result.applied).toBe(false);
		// The longer, already-active 429 bench must survive untouched.
		const row = getAudit(db, "acc-2");
		expect(row.rate_limited_reason).toBe("upstream_429_with_reset");
		expect(row.rate_limited_until).toBe(X);
	});

	it("applies a 529 write when the account currently has no cooldown at all", async () => {
		insertAccount(db, "acc-3");
		const until = Date.now() + 10_000;

		const result = await repo.markAccountRateLimited(
			"acc-3",
			until,
			"upstream_529_overloaded_no_reset",
			false,
		);

		expect(result.applied).toBe(true);
		const row = getAudit(db, "acc-3");
		expect(row.rate_limited_reason).toBe("upstream_529_overloaded_no_reset");
		expect(row.rate_limited_until).toBe(until);
	});

	it("reports applied=true for the 429 (incrementStreak) path unconditionally", async () => {
		insertAccount(db, "acc-4");
		const until = Date.now() + 30_000;

		const result = await repo.markAccountRateLimited(
			"acc-4",
			until,
			"upstream_429_no_reset_probe_cooldown",
			true,
		);

		expect(result.applied).toBe(true);
		expect(result.consecutiveRateLimits).toBe(1);
	});

	it("logs a neutral warning naming the account when the guarded write is skipped (delta2-6)", async () => {
		insertAccount(db, "acc-5");
		const X = Date.now() + 5 * 60 * 1000;
		await repo.markAccountRateLimited(
			"acc-5",
			X,
			"upstream_429_with_reset",
			true,
		);

		const warnSpy = spyOn(Logger.prototype, "warn");
		try {
			const shorter = X - 60_000;
			await repo.markAccountRateLimited(
				"acc-5",
				shorter,
				"upstream_529_overloaded_no_reset",
				false,
			);

			// Row-state assertions alone (as in the sibling tests above) don't
			// prove this observability line actually fires — the whole point of
			// delta2-3's rate_limited_write_skipped message is to give an
			// operator a signal when the DB row diverges from what the caller
			// wrote. It must not assert a specific cause (see the message text):
			// changes===0 covers both "a longer cooldown is active" and "the row
			// is absent" and can't tell them apart from the row count alone.
			const skipCall = warnSpy.mock.calls.find((call) =>
				String(call[0]).includes("rate_limited_write_skipped"),
			);
			expect(skipCall).toBeDefined();
			expect(String(skipCall?.[0])).toContain("account=acc-5");
			expect(String(skipCall?.[0])).not.toMatch(
				/a longer cooldown is already active in the DB/,
			);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
