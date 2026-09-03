import "@better-ccflare/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

interface RawRateLimitRow {
	rate_limit_status: string | null;
	rate_limit_reset: number | null;
	rate_limit_reset_at: number | null;
}

// Regression coverage for PR #445's round-2 review finding: the original
// clearStaleRateLimitReset CAS only compared the stored rate_limit_reset
// value against the one the caller had just read, which protects the
// read→write gap but not the poll-observation→read gap. A genuine 429
// landing between "the poller observed the fresh-window contradiction" and
// "the callback's getAccount() read the row" would write a new, legitimate
// rate_limit_reset that happens to be read back and value-matched by the old
// CAS — incorrectly clearing a real rate limit. Threading rate_limit_reset_at
// (the write-time of rate_limit_reset) and requiring it to be no newer than
// the poll's observedAt timestamp closes that gap.
describe("AccountRepository.clearStaleRateLimitReset — write-time CAS guard (#445 round-2 fix)", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
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
				requires_reauth INTEGER DEFAULT 0,
				rate_limit_reset INTEGER,
				rate_limit_reset_at INTEGER,
				rate_limit_status TEXT,
				rate_limit_remaining INTEGER,
				priority INTEGER DEFAULT 0,
				auto_fallback_enabled INTEGER DEFAULT 0,
				auto_refresh_enabled INTEGER DEFAULT 0,
				auto_pause_on_overage_enabled INTEGER DEFAULT 0,
				peak_hours_pause_enabled INTEGER DEFAULT 0,
				custom_endpoint TEXT,
				model_mappings TEXT,
				cross_region_mode TEXT,
				model_fallbacks TEXT,
				billing_type TEXT,
				pause_reason TEXT,
				refresh_token_issued_at INTEGER,
				consecutive_rate_limits INTEGER DEFAULT 0
			)
		`);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	function insertAccount(
		id: string,
		rateLimitReset: number | null,
		rateLimitResetAt: number | null,
	): void {
		db.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, rate_limit_status, rate_limit_reset, rate_limit_reset_at)
			 VALUES (?, ?, 'anthropic', '', 'at', 1, 1, 'rate_limited', ?, ?)`,
			[id, id, rateLimitReset, rateLimitResetAt],
		);
	}

	function getRaw(id: string): RawRateLimitRow {
		return db
			.query<RawRateLimitRow, [string]>(
				"SELECT rate_limit_status, rate_limit_reset, rate_limit_reset_at FROM accounts WHERE id = ?",
			)
			.get(id) as RawRateLimitRow;
	}

	it("clears when rate_limit_reset_at < observedAt", async () => {
		const futureReset = Date.now() + 60_000;
		const writtenAt = 1_000_000;
		const observedAt = 2_000_000; // observed strictly after the stale write
		insertAccount("acct-clears", futureReset, writtenAt);

		const cleared = await repository.clearStaleRateLimitReset(
			"acct-clears",
			futureReset,
			observedAt,
		);

		expect(cleared).toBe(true);
		const row = getRaw("acct-clears");
		expect(row.rate_limit_status).toBe("allowed");
		expect(row.rate_limit_reset).toBeNull();
		expect(row.rate_limit_reset_at).toBeNull();
	});

	it("does NOT clear when rate_limit_reset_at > observedAt (fresh legitimate write landed after observation)", async () => {
		const futureReset = Date.now() + 60_000;
		const observedAt = 1_000_000;
		const writtenAt = 2_000_000; // a genuine 429 wrote this AFTER the poll observed the contradiction
		insertAccount("acct-race", futureReset, writtenAt);

		const cleared = await repository.clearStaleRateLimitReset(
			"acct-race",
			futureReset,
			observedAt,
		);

		expect(cleared).toBe(false);
		const row = getRaw("acct-race");
		expect(row.rate_limit_status).toBe("rate_limited");
		expect(row.rate_limit_reset).toBe(futureReset);
		expect(row.rate_limit_reset_at).toBe(writtenAt);
	});

	it("does NOT clear when rate_limit_reset_at === observedAt (same-millisecond write, strict guard)", async () => {
		const futureReset = Date.now() + 60_000;
		const sameInstant = 1_500_000;
		insertAccount("acct-same-ms", futureReset, sameInstant);

		const cleared = await repository.clearStaleRateLimitReset(
			"acct-same-ms",
			futureReset,
			sameInstant,
		);

		expect(cleared).toBe(false);
		const row = getRaw("acct-same-ms");
		expect(row.rate_limit_status).toBe("rate_limited");
		expect(row.rate_limit_reset).toBe(futureReset);
		expect(row.rate_limit_reset_at).toBe(sameInstant);
	});

	it("still clears when rate_limit_reset_at IS NULL (legacy rows predating the column)", async () => {
		const futureReset = Date.now() + 60_000;
		const observedAt = 1_000_000;
		insertAccount("acct-legacy", futureReset, null);

		const cleared = await repository.clearStaleRateLimitReset(
			"acct-legacy",
			futureReset,
			observedAt,
		);

		expect(cleared).toBe(true);
		const row = getRaw("acct-legacy");
		expect(row.rate_limit_status).toBe("allowed");
		expect(row.rate_limit_reset).toBeNull();
		expect(row.rate_limit_reset_at).toBeNull();
	});

	it("does not clear when the value no longer matches expectedReset (original read→write CAS)", async () => {
		const originalReset = Date.now() + 60_000;
		const newerReset = Date.now() + 120_000;
		const observedAt = 2_000_000;
		insertAccount("acct-value-mismatch", newerReset, 1_000_000);

		const cleared = await repository.clearStaleRateLimitReset(
			"acct-value-mismatch",
			originalReset,
			observedAt,
		);

		expect(cleared).toBe(false);
		const row = getRaw("acct-value-mismatch");
		expect(row.rate_limit_reset).toBe(newerReset);
	});

	it("returns false when the account id does not exist", async () => {
		const cleared = await repository.clearStaleRateLimitReset(
			"missing-account",
			12345,
			1_000_000,
		);

		expect(cleared).toBe(false);
	});
});

describe("AccountRepository — rate_limit_reset_at stamping", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
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
				requires_reauth INTEGER DEFAULT 0,
				rate_limit_reset INTEGER,
				rate_limit_reset_at INTEGER,
				rate_limit_status TEXT,
				rate_limit_remaining INTEGER,
				priority INTEGER DEFAULT 0,
				auto_fallback_enabled INTEGER DEFAULT 0,
				auto_refresh_enabled INTEGER DEFAULT 0,
				auto_pause_on_overage_enabled INTEGER DEFAULT 0,
				peak_hours_pause_enabled INTEGER DEFAULT 0,
				custom_endpoint TEXT,
				model_mappings TEXT,
				cross_region_mode TEXT,
				model_fallbacks TEXT,
				billing_type TEXT,
				pause_reason TEXT,
				refresh_token_issued_at INTEGER,
				consecutive_rate_limits INTEGER DEFAULT 0
			)
		`);
		db.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["acct-1", "Account 1", "anthropic", "", "at", 1, 1],
		);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	function getRaw(id: string): RawRateLimitRow {
		return db
			.query<RawRateLimitRow, [string]>(
				"SELECT rate_limit_status, rate_limit_reset, rate_limit_reset_at FROM accounts WHERE id = ?",
			)
			.get(id) as RawRateLimitRow;
	}

	it("stamps rate_limit_reset_at to now when updateRateLimitMeta sets a reset value", async () => {
		const before = Date.now();
		await repository.updateRateLimitMeta("acct-1", "rate_limited", 999_999);
		const after = Date.now();

		const row = getRaw("acct-1");
		expect(row.rate_limit_reset).toBe(999_999);
		expect(row.rate_limit_reset_at).not.toBeNull();
		expect(row.rate_limit_reset_at as number).toBeGreaterThanOrEqual(before);
		expect(row.rate_limit_reset_at as number).toBeLessThanOrEqual(after);
	});

	it("nulls rate_limit_reset_at when updateRateLimitMeta clears the reset (reset === null)", async () => {
		await repository.updateRateLimitMeta("acct-1", "rate_limited", 999_999);
		await repository.updateRateLimitMeta("acct-1", "allowed", null);

		const row = getRaw("acct-1");
		expect(row.rate_limit_reset).toBeNull();
		expect(row.rate_limit_reset_at).toBeNull();
	});

	it("clearRateLimitState nulls rate_limit_reset_at along with rate_limit_reset", async () => {
		await repository.updateRateLimitMeta("acct-1", "rate_limited", 999_999);

		await repository.clearRateLimitState("acct-1");

		const row = getRaw("acct-1");
		expect(row.rate_limit_reset).toBeNull();
		expect(row.rate_limit_reset_at).toBeNull();
		expect(row.rate_limit_status).toBeNull();
	});
});
