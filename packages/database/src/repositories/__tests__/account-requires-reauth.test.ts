import "@better-ccflare/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

describe("AccountRepository requires_reauth", () => {
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
			"INSERT INTO accounts (id, name, access_token, expires_at, created_at) VALUES ('account-1', 'Account 1', 'old-token', 1, 1)",
		);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("round-trips requires_reauth through setRequiresReauth and findById", async () => {
		await repository.setRequiresReauth("account-1", true);

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			true,
		);

		await repository.setRequiresReauth("account-1", false);

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			false,
		);
	});

	it("clears requires_reauth when tokens are updated without rotation", async () => {
		await repository.setRequiresReauth("account-1", true);

		await repository.updateTokens("account-1", "new-token", 2);

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			false,
		);
	});

	it("clears requires_reauth when tokens are updated with refresh-token rotation", async () => {
		await repository.setRequiresReauth("account-1", true);

		await repository.updateTokens("account-1", "new-token", 2, "new-refresh");

		expect((await repository.findById("account-1"))?.requires_reauth).toBe(
			false,
		);
	});
});
