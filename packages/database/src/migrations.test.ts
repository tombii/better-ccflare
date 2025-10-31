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
    `).run("test-id", "test-account", "anthropic", "", Date.now(), "pro");

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

		stmt.run("id1", "account1", "anthropic", "", 1000, 2000, 0, "free");
		stmt.run("id2", "account2", "anthropic", "", 1001, 2001, 10, "pro");
		stmt.run("id3", "account3", "zai", "", 1002, 2002, 20, "enterprise");

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

	it("should migrate existing 'max' mode values to 'claude-oauth' in oauth_sessions table", () => {
		// Create schema with mode column (simulate old schema)
		db.exec(`
      CREATE TABLE oauth_sessions (
        id TEXT PRIMARY KEY,
        account_name TEXT NOT NULL,
        verifier TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

		// Insert test data with 'max' mode (legacy)
		db.prepare(`
      INSERT INTO oauth_sessions (id, account_name, verifier, mode, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"session-max",
			"test-account-max",
			"test-verifier-max",
			"max", // This is the legacy value that should be converted
			Date.now(),
			Date.now() + 3600000,
		);

		// Insert another record with 'console' mode (should remain unchanged)
		db.prepare(`
      INSERT INTO oauth_sessions (id, account_name, verifier, mode, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"session-console",
			"test-account-console",
			"test-verifier-console",
			"console", // This should remain unchanged
			Date.now(),
			Date.now() + 3600000,
		);

		// Insert another record with 'claude-oauth' mode (should remain unchanged)
		db.prepare(`
      INSERT INTO oauth_sessions (id, account_name, verifier, mode, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"session-claude",
			"test-account-claude",
			"test-verifier-claude",
			"claude-oauth", // This should remain unchanged
			Date.now(),
			Date.now() + 3600000,
		);

		// Run migrations (should convert 'max' to 'claude-oauth')
		runMigrations(db);

		// Verify that 'max' was converted to 'claude-oauth' while others remain unchanged
		const sessions = db
			.prepare(
				"SELECT id, account_name, mode FROM oauth_sessions ORDER BY account_name",
			)
			.all() as Array<{
			id: string;
			account_name: string;
			mode: string;
		}>;

		expect(sessions).toHaveLength(3);

		// Find the specific session that had 'max' mode
		const maxSession = sessions.find((s) => s.id === "session-max");
		expect(maxSession).toBeDefined();
		expect(maxSession?.mode).toBe("claude-oauth"); // Should be converted

		// Find the console session (should be unchanged)
		const consoleSession = sessions.find((s) => s.id === "session-console");
		expect(consoleSession).toBeDefined();
		expect(consoleSession?.mode).toBe("console"); // Should remain unchanged

		// Find the claude-oauth session (should be unchanged)
		const claudeSession = sessions.find((s) => s.id === "session-claude");
		expect(claudeSession).toBeDefined();
		expect(claudeSession?.mode).toBe("claude-oauth"); // Should remain unchanged
	});

	describe("API Key Storage Migration", () => {
		it("should migrate API keys from refresh_token to api_key field for API-key providers", () => {
			// Initialize the schema
			ensureSchema(db);

			// Insert test data with API keys stored in refresh_token field (old pattern)
			const stmt = db.prepare(`
				INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
				VALUES (?, ?, ?, ?, ?, ?)
			`);

			// Insert API-key providers with keys in refresh_token field
			stmt.run(
				"zai-account",
				"zai-account",
				"zai",
				"sk-zai-key-12345",
				Date.now(),
				10,
			);
			stmt.run(
				"minimax-account",
				"minimax-account",
				"minimax",
				"sk-minimax-key-67890",
				Date.now(),
				20,
			);
			stmt.run(
				"openai-account",
				"openai-account",
				"openai-compatible",
				"sk-openai-key-abcde",
				Date.now(),
				30,
			);
			stmt.run(
				"anthropic-compatible-account",
				"anthropic-compatible-account",
				"anthropic-compatible",
				"sk-anthropic-key-fghij",
				Date.now(),
				40,
			);

			// Debug: Check initial state
			const initialZaiAccount = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token FROM accounts WHERE id = ?",
				)
				.get("zai-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
			};
			console.log("Initial zai account:", initialZaiAccount);

			// Run migrations
			runMigrations(db);

			// Debug: Check final state
			const finalZaiAccount = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token FROM accounts WHERE id = ?",
				)
				.get("zai-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
			};
			console.log("Final zai account:", finalZaiAccount);

			// Verify that API keys were moved from refresh_token to api_key field
			const zaiAccount = finalZaiAccount;

			expect(zaiAccount.api_key).toBe("sk-zai-key-12345");
			expect(zaiAccount.refresh_token).toBe("");

			const minimaxAccount = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token FROM accounts WHERE id = ?",
				)
				.get("minimax-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
			};

			expect(minimaxAccount.api_key).toBe("sk-minimax-key-67890");
			expect(minimaxAccount.refresh_token).toBe("");

			const openaiAccount = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token FROM accounts WHERE id = ?",
				)
				.get("openai-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
			};

			expect(openaiAccount.api_key).toBe("sk-openai-key-abcde");
			expect(openaiAccount.refresh_token).toBe("");

			const anthropicCompatibleAccount = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token FROM accounts WHERE id = ?",
				)
				.get("anthropic-compatible-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
			};

			expect(anthropicCompatibleAccount.api_key).toBe("sk-anthropic-key-fghij");
			expect(anthropicCompatibleAccount.refresh_token).toBe("");
		});

		it("should clean up duplicate API key storage", () => {
			// Initialize the schema
			ensureSchema(db);

			// Insert test data with duplicate API key storage
			db.prepare(`
				INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token, created_at, priority)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"duplicate-account",
				"duplicate-account",
				"zai",
				"sk-duplicate-key", // api_key field
				"sk-duplicate-key", // refresh_token field (duplicate)
				"sk-duplicate-key", // access_token field (duplicate)
				Date.now(),
				10,
			);

			// Run migrations
			runMigrations(db);

			// Verify that duplicates were cleaned up
			const account = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token, access_token FROM accounts WHERE id = ?",
				)
				.get("duplicate-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
			};

			expect(account.api_key).toBe("sk-duplicate-key"); // Should remain
			expect(account.refresh_token).toBe(""); // Should be cleared to empty string
			expect(account.access_token).toBe(""); // Should be cleared to empty string
		});

		it("should detect and migrate console accounts with enhanced logic", () => {
			// Initialize the schema
			ensureSchema(db);

			// Insert test data for console account detection
			db.prepare(`
				INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, priority)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"console-account",
				"console-account",
				"anthropic",
				"sk-console-api-key-12345", // API key in refresh_token field
				null, // No access token
				null, // No expiration
				Date.now(),
				10,
			);

			// Run migrations
			runMigrations(db);

			// Verify that console account was detected and migrated
			const account = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token, access_token FROM accounts WHERE id = ?",
				)
				.get("console-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
			};

			expect(account.api_key).toBe("sk-console-api-key-12345");
			expect(account.refresh_token).toBe("");
			expect(account.access_token).toBe("");
		});

		it("should not migrate OAuth accounts that match console detection patterns", () => {
			// Initialize the schema
			ensureSchema(db);

			const futureTime = Date.now() + 24 * 60 * 60 * 1000; // 24 hours from now

			// Insert OAuth account that might match some patterns but has valid OAuth characteristics
			db.prepare(`
				INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, priority)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"oauth-account",
				"oauth-account",
				"anthropic",
				"sk-ant-api03-12345", // OAuth refresh token pattern
				"sk-ant-api03-67890", // Has access token
				futureTime, // Valid future expiration
				Date.now(),
				10,
			);

			// Run migrations
			runMigrations(db);

			// Verify that OAuth account was NOT migrated (should keep refresh_token)
			const account = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token, access_token FROM accounts WHERE id = ?",
				)
				.get("oauth-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
			};

			expect(account.api_key).toBeNull(); // Should not have api_key
			expect(account.refresh_token).toBe("sk-ant-api03-12345"); // Should keep refresh_token
			expect(account.access_token).toBe("sk-ant-api03-67890"); // Should keep access_token
		});

		it("should handle expired OAuth tokens correctly", () => {
			// Initialize the schema
			ensureSchema(db);

			const now = Date.now();
			const pastTime = now - 48 * 60 * 60 * 1000; // 48 hours ago (expired - more than 24h)

			// Insert expired OAuth account
			db.prepare(`
				INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, priority)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"expired-oauth-account",
				"expired-oauth-account",
				"anthropic",
				"sk-custom-token-12345", // Non-OAuth pattern
				null, // No access token
				pastTime, // Expired timestamp (more than 24h ago)
				now,
				10,
			);

			// Run migrations
			runMigrations(db);

			// Verify that expired OAuth account was migrated to console
			const account = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token, access_token FROM accounts WHERE id = ?",
				)
				.get("expired-oauth-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
			};

			expect(account.api_key).toBe("sk-custom-token-12345");
			expect(account.refresh_token).toBe("");
			expect(account.access_token).toBe("");
		});

		it("should not affect OAuth accounts with valid characteristics", () => {
			// Initialize the schema
			ensureSchema(db);

			// Insert valid OAuth account
			db.prepare(`
				INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, priority)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"valid-oauth-account",
				"valid-oauth-account",
				"anthropic",
				"sk-ant-api03-oauth-refresh",
				"sk-ant-api03-oauth-access",
				Date.now() + 3600000, // Valid expiration (1 hour from now)
				Date.now(),
				10,
			);

			// Run migrations
			runMigrations(db);

			// Verify that valid OAuth account was NOT migrated
			const account = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token, access_token FROM accounts WHERE id = ?",
				)
				.get("valid-oauth-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
			};

			expect(account.api_key).toBeNull();
			expect(account.refresh_token).toBe("sk-ant-api03-oauth-refresh");
			expect(account.access_token).toBe("sk-ant-api03-oauth-access");
		});

		it("should preserve OAuth accounts with claude-oauth provider", () => {
			// Initialize the schema
			ensureSchema(db);

			// Insert valid OAuth account with claude-oauth provider
			db.prepare(`
				INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, priority)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				"claude-oauth-account",
				"claude-oauth-account",
				"anthropic",
				"sk-ant-api03-claude-refresh",
				"sk-ant-api03-claude-access",
				Date.now() + 3600000,
				Date.now(),
				10,
			);

			// Run migrations
			runMigrations(db);

			// Verify that claude-oauth account was NOT migrated
			const account = db
				.prepare(
					"SELECT id, name, provider, api_key, refresh_token, access_token FROM accounts WHERE id = ?",
				)
				.get("claude-oauth-account") as {
				id: string;
				name: string;
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
			};

			expect(account.api_key).toBeNull();
			expect(account.refresh_token).toBe("sk-ant-api03-claude-refresh");
			expect(account.access_token).toBe("sk-ant-api03-claude-access");
		});
	});
});
