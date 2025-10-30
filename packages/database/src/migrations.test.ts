import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../src/migrations";

describe("Database Migrations - Tier Column Removal", () => {
	let db: Database;

	beforeEach(() => {
		// Create an in-memory database for testing
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("should handle migration when tier columns do not exist", () => {
		// Initialize the schema without tier columns
		ensureSchema(db);

		// Run migrations (should complete without errors even without tier columns)
		expect(() => {
			runMigrations(db);
		}).not.toThrow();

		// Verify that the basic schema is still intact
		const accountsColumns = db
			.prepare("PRAGMA table_info(accounts)")
			.all() as Array<{ name: string }>;
		const columnNames = accountsColumns.map((col) => col.name);

		// Verify that essential columns still exist after migration
		expect(columnNames).toContain("id");
		expect(columnNames).toContain("name");
		expect(columnNames).toContain("provider");
		expect(columnNames).toContain("priority");
		expect(columnNames).not.toContain("account_tier"); // Should not exist initially
	});

	it("should remove account_tier column from accounts table if it exists", () => {
		// Create schema with tier column (simulate old schema)
		db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT DEFAULT 'anthropic',
        api_key TEXT,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        last_used INTEGER,
        request_count INTEGER DEFAULT 0,
        total_requests INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        account_tier TEXT DEFAULT 'free'  -- This is the column we want to remove
      )
    `);

		// Insert test data with tier
		db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, created_at, account_tier)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"test-id",
			"test-account",
			"anthropic",
			"test-token",
			Date.now(),
			"pro",
		);

		// Run migrations (should remove the tier column)
		runMigrations(db);

		// Check that the tier column was removed
		const accountsColumns = db
			.prepare("PRAGMA table_info(accounts)")
			.all() as Array<{ name: string }>;
		const columnNames = accountsColumns.map((col) => col.name);

		expect(columnNames).not.toContain("account_tier");
		expect(columnNames).toContain("id");
		expect(columnNames).toContain("name");
		expect(columnNames).toContain("priority");

		// Verify that data was preserved (except the removed column)
		const account = db
			.prepare("SELECT id, name, provider FROM accounts WHERE id = ?")
			.get("test-id") as { id: string; name: string; provider: string };
		expect(account.id).toBe("test-id");
		expect(account.name).toBe("test-account");
		expect(account.provider).toBe("anthropic");
	});

	it("should remove tier column from oauth_sessions table if it exists", () => {
		// Create schema with tier column in oauth_sessions (simulate old schema)
		db.exec(`
      CREATE TABLE oauth_sessions (
        id TEXT PRIMARY KEY,
        account_name TEXT NOT NULL,
        verifier TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        tier TEXT DEFAULT 'free'  -- This is the column we want to remove
      )
    `);

		// Insert test data with tier
		db.prepare(`
      INSERT INTO oauth_sessions (id, account_name, verifier, mode, created_at, expires_at, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
			"session-id",
			"test-account",
			"test-verifier",
			"claude-oauth",
			Date.now(),
			Date.now() + 3600000,
			"pro",
		);

		// Run migrations (should remove the tier column)
		runMigrations(db);

		// Check that the tier column was removed
		const oauthColumns = db
			.prepare("PRAGMA table_info(oauth_sessions)")
			.all() as Array<{ name: string }>;
		const columnNames = oauthColumns.map((col) => col.name);

		expect(columnNames).not.toContain("tier");
		expect(columnNames).toContain("id");
		expect(columnNames).toContain("account_name");
		expect(columnNames).toContain("verifier");

		// Verify that data was preserved (except the removed column)
		const session = db
			.prepare(
				"SELECT id, account_name, verifier, mode FROM oauth_sessions WHERE id = ?",
			)
			.get("session-id") as {
			id: string;
			account_name: string;
			verifier: string;
			mode: string;
		};
		expect(session.id).toBe("session-id");
		expect(session.account_name).toBe("test-account");
		expect(session.verifier).toBe("test-verifier");
		expect(session.mode).toBe("claude-oauth");
	});

	it("should preserve data integrity during tier column removal", () => {
		// Create schema with tier columns (simulate old schema with all current columns plus tier)
		db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT DEFAULT 'anthropic',
        api_key TEXT,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        last_used INTEGER,
        request_count INTEGER DEFAULT 0,
        total_requests INTEGER DEFAULT 0,
        priority INTEGER DEFAULT 0,
        rate_limited_until INTEGER,
        session_start INTEGER,
        session_request_count INTEGER DEFAULT 0,
        paused INTEGER DEFAULT 0,
        rate_limit_reset INTEGER,
        rate_limit_status TEXT,
        rate_limit_remaining INTEGER,
        auto_fallback_enabled INTEGER DEFAULT 0,
        custom_endpoint TEXT,
        auto_refresh_enabled INTEGER DEFAULT 0,
        model_mappings TEXT,
        account_tier TEXT DEFAULT 'free'  -- This is the column we want to remove
      )
    `);

		// Insert multiple test records
		const stmt = db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, created_at, last_used, priority, account_tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

		stmt.run("id1", "account1", "anthropic", "token1", 1000, 2000, 0, "free");
		stmt.run("id2", "account2", "anthropic", "token2", 1001, 2001, 10, "pro");
		stmt.run("id3", "account3", "zai", "token3", 1002, 2002, 20, "enterprise");

		// Run migrations
		runMigrations(db);

		// Verify all accounts are preserved with correct data
		const accounts = db
			.prepare(
				"SELECT id, name, provider, refresh_token, priority FROM accounts ORDER BY priority",
			)
			.all() as Array<{
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			priority: number;
		}>;

		expect(accounts).toHaveLength(3);
		expect(accounts[0].id).toBe("id1");
		expect(accounts[0].name).toBe("account1");
		expect(accounts[0].provider).toBe("anthropic");
		expect(accounts[0].priority).toBe(0);

		expect(accounts[1].id).toBe("id2");
		expect(accounts[1].name).toBe("account2");
		expect(accounts[1].priority).toBe(10);

		expect(accounts[2].id).toBe("id3");
		expect(accounts[2].name).toBe("account3");
		expect(accounts[2].provider).toBe("zai");
		expect(accounts[2].priority).toBe(20);
	});
});
