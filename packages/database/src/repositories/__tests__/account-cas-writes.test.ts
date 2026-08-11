import "@better-ccflare/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

interface RawAccountRow {
	access_token: string | null;
	expires_at: number | null;
	refresh_token: string | null;
	refresh_token_issued_at: number | null;
	requires_reauth: number;
}

describe("AccountRepository — compare-and-set token/requires_reauth writes (rotation-race hardening)", () => {
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
			["account-1", "Account 1", "anthropic", "rt-original", "at-old", 1, 1],
		);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	function getRaw(id: string): RawAccountRow {
		return db
			.query<RawAccountRow, [string]>(
				"SELECT access_token, expires_at, refresh_token, refresh_token_issued_at, requires_reauth FROM accounts WHERE id = ?",
			)
			.get(id) as RawAccountRow;
	}

	describe("updateTokensIfRefreshTokenMatches", () => {
		it("applies the write and returns true when expectedRefreshToken matches, resetting requires_reauth and rotating the refresh token when one is passed", async () => {
			await repository.setRequiresReauth("account-1", true);

			const result = await repository.updateTokensIfRefreshTokenMatches(
				"account-1",
				"rt-original",
				"at-new",
				999,
				"rt-rotated",
			);

			expect(result).toBe(true);
			const row = getRaw("account-1");
			expect(row.access_token).toBe("at-new");
			expect(row.expires_at).toBe(999);
			expect(row.refresh_token).toBe("rt-rotated");
			expect(row.refresh_token_issued_at).not.toBeNull();
			expect(row.requires_reauth).toBe(0);
		});

		it("updates access_token/expires_at and resets requires_reauth without touching refresh_token when no new refresh token is passed", async () => {
			await repository.setRequiresReauth("account-1", true);

			const result = await repository.updateTokensIfRefreshTokenMatches(
				"account-1",
				"rt-original",
				"at-new",
				999,
			);

			expect(result).toBe(true);
			const row = getRaw("account-1");
			expect(row.access_token).toBe("at-new");
			expect(row.expires_at).toBe(999);
			expect(row.refresh_token).toBe("rt-original");
			expect(row.requires_reauth).toBe(0);
		});

		it("returns false and leaves the row unchanged when expectedRefreshToken no longer matches (rotated concurrently)", async () => {
			const result = await repository.updateTokensIfRefreshTokenMatches(
				"account-1",
				"rt-stale",
				"at-new",
				999,
				"rt-rotated",
			);

			expect(result).toBe(false);
			const row = getRaw("account-1");
			expect(row.access_token).toBe("at-old");
			expect(row.expires_at).toBe(1);
			expect(row.refresh_token).toBe("rt-original");
			expect(row.requires_reauth).toBe(0);
		});
	});

	describe("flagRequiresReauthIfTokenMatches", () => {
		it("sets requires_reauth = 1 and returns true when expectedRefreshToken matches", async () => {
			const result = await repository.flagRequiresReauthIfTokenMatches(
				"account-1",
				"rt-original",
			);

			expect(result).toBe(true);
			expect(getRaw("account-1").requires_reauth).toBe(1);
		});

		it("returns false and leaves requires_reauth at 0 when the refresh token was rotated concurrently", async () => {
			const result = await repository.flagRequiresReauthIfTokenMatches(
				"account-1",
				"rt-rotated-elsewhere",
			);

			expect(result).toBe(false);
			expect(getRaw("account-1").requires_reauth).toBe(0);
		});

		it("returns false when the account id does not exist", async () => {
			const result = await repository.flagRequiresReauthIfTokenMatches(
				"missing-account",
				"rt-original",
			);

			expect(result).toBe(false);
		});
	});
});
