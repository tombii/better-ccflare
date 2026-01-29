import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "@better-ccflare/logger";
import { addPerformanceIndexes } from "./performance-indexes";

const log = new Logger("DatabaseMigrations");

export function ensureSchema(db: Database): void {
	// Create accounts table
	db.run(`
		CREATE TABLE IF NOT EXISTS accounts (
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
			priority INTEGER DEFAULT 0
		)
	`);

	// Create requests table
	db.run(`
		CREATE TABLE IF NOT EXISTS requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			account_used TEXT,
			status_code INTEGER,
			success BOOLEAN,
			error_message TEXT,
			response_time_ms INTEGER,
			failover_attempts INTEGER DEFAULT 0,
			model TEXT,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cost_usd REAL DEFAULT 0,
			output_tokens_per_second REAL,
			input_tokens INTEGER DEFAULT 0,
			cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			agent_used TEXT
		)
	`);

	// Create indexes for faster queries
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC)`,
	);

	// Index for JOIN performance with accounts table
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_account_used ON requests(account_used)`,
	);

	// Composite index for the main requests query (timestamp DESC with account_used for JOIN)
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp_account ON requests(timestamp DESC, account_used)`,
	);

	// Create request_payloads table for storing full request/response data
	db.run(`
		CREATE TABLE IF NOT EXISTS request_payloads (
			id TEXT PRIMARY KEY,
			json TEXT NOT NULL,
			FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	// Create oauth_sessions table for secure PKCE verifier storage
	db.run(`
		CREATE TABLE IF NOT EXISTS oauth_sessions (
			id TEXT PRIMARY KEY,
			account_name TEXT NOT NULL,
			verifier TEXT NOT NULL,
			mode TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)
	`);

	// Create index for faster cleanup of expired sessions
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON oauth_sessions(expires_at)`,
	);

	// Create agent_preferences table for storing user-defined agent settings
	db.run(`
		CREATE TABLE IF NOT EXISTS agent_preferences (
			agent_id TEXT PRIMARY KEY,
			model TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// Create api_keys table for optional API authentication
	db.run(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			hashed_key TEXT NOT NULL UNIQUE,
			prefix_last_8 TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			usage_count INTEGER DEFAULT 0,
			is_active INTEGER DEFAULT 1
		)
	`);

	// Create index for faster API key lookups
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_api_keys_hashed_key ON api_keys(hashed_key)`,
	);

	// Create index for active API keys
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)`,
	);
}

export function runMigrations(db: Database, dbPath?: string): void {
	// Ensure base schema exists first (outside transaction as it creates tables)
	ensureSchema(db);

	// Check if columns exist before adding them
	const accountsInfo = db
		.prepare("PRAGMA table_info(accounts)")
		.all() as Array<{
		cid: number;
		name: string;
		type: string;
		notnull: number;
		// biome-ignore lint/suspicious/noExplicitAny: SQLite pragma can return various default value types
		dflt_value: any;
		pk: number;
	}>;

	const initialAccountsColumnNames = accountsInfo.map((col) => col.name);

	// Check final column structure to determine if backup is needed
	const finalAccountsColumns = db
		.prepare("PRAGMA table_info(accounts)")
		.all() as Array<{
		cid: number;
		name: string;
		type: string;
		notnull: number;
		// biome-ignore lint/suspicious/noExplicitAny: SQLite pragma can return various default value types
		dflt_value: any;
		pk: number;
	}>;

	const finalAccountsColumnNames = finalAccountsColumns.map((col) => col.name);

	// Check oauth_sessions table as well
	const finalOAuthColumns = db
		.prepare("PRAGMA table_info(oauth_sessions)")
		.all() as Array<{
		cid: number;
		name: string;
		type: string;
		notnull: number;
		// biome-ignore lint/suspicious/noExplicitAny: SQLite pragma can return various default value types
		dflt_value: any;
		pk: number;
	}>;

	const finalOAuthColumnNames = finalOAuthColumns.map((col) => col.name);

	// Create backup if tier columns exist (before any database operations)
	const hasTierColumns =
		finalAccountsColumnNames.includes("account_tier") ||
		finalOAuthColumnNames.includes("tier");

	if (hasTierColumns) {
		// Create backup before removing tier columns using file copy
		// Validate dbPath and use a proper default
		const sourcePath = dbPath && dbPath !== "" ? dbPath : "better-ccflare.db";

		try {
			// Resolve to absolute path to prevent directory traversal attacks
			const absoluteSourcePath = path.resolve(sourcePath);

			// Additional security validation - check for unsafe path patterns that could indicate directory traversal
			// This prevents potential security issues if dbPath comes from untrusted sources in the future
			if (
				absoluteSourcePath.includes("../") ||
				absoluteSourcePath.includes("..\\") ||
				absoluteSourcePath.endsWith("..") ||
				absoluteSourcePath.startsWith("..")
			) {
				log.warn(`Unsafe path detected: ${sourcePath}. Skipping backup.`);
				// Continue with the rest of the migration to ensure database schema updates still occur
			} else if (fs.existsSync(absoluteSourcePath)) {
				// Check if it's actually a file (not a directory) to prevent backup errors
				const stats = fs.statSync(absoluteSourcePath);
				if (stats.isFile()) {
					// Use the validated database path for backup
					const backupPath = `${absoluteSourcePath}.backup.${Date.now()}`;
					fs.copyFileSync(absoluteSourcePath, backupPath);
					log.info(`Database backup created at: ${backupPath}`);
				} else {
					log.warn(
						`Database path is not a file: ${absoluteSourcePath}. Skipping backup.`,
					);
				}
			} else {
				log.warn(
					`Database file does not exist at path: ${absoluteSourcePath}. Skipping backup.`,
				);
			}
		} catch (error) {
			// Catch any errors during backup process to ensure migrations continue
			log.warn(
				`Error during database backup validation: ${(error as Error).message}. Skipping backup.`,
			);
		}
	}

	// Wrap database operations in a transaction for atomicity
	const migrationTx = db.transaction(() => {
		// Add rate_limited_until column if it doesn't exist
		if (!initialAccountsColumnNames.includes("rate_limited_until")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN rate_limited_until INTEGER",
			).run();
			log.info("Added rate_limited_until column to accounts table");
		}

		// Add session_start column if it doesn't exist
		if (!initialAccountsColumnNames.includes("session_start")) {
			db.prepare("ALTER TABLE accounts ADD COLUMN session_start INTEGER").run();
			log.info("Added session_start column to accounts table");
		}

		// Add session_request_count column if it doesn't exist
		if (!initialAccountsColumnNames.includes("session_request_count")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN session_request_count INTEGER DEFAULT 0",
			).run();
			log.info("Added session_request_count column to accounts table");
		}

		// Add paused column if it doesn't exist
		if (!initialAccountsColumnNames.includes("paused")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN paused INTEGER DEFAULT 0",
			).run();
			log.info("Added paused column to accounts table");
		}

		// Add rate_limit_reset column if it doesn't exist
		if (!initialAccountsColumnNames.includes("rate_limit_reset")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN rate_limit_reset INTEGER",
			).run();
			log.info("Added rate_limit_reset column to accounts table");
		}

		// Add rate_limit_status column if it doesn't exist
		if (!initialAccountsColumnNames.includes("rate_limit_status")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN rate_limit_status TEXT",
			).run();
			log.info("Added rate_limit_status column to accounts table");
		}

		// Add rate_limit_remaining column if it doesn't exist
		if (!initialAccountsColumnNames.includes("rate_limit_remaining")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN rate_limit_remaining INTEGER",
			).run();
			log.info("Added rate_limit_remaining column to accounts table");
		}

		// Add priority column if it doesn't exist
		if (!initialAccountsColumnNames.includes("priority")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN priority INTEGER DEFAULT 0",
			).run();
			log.info("Added priority column to accounts table");
		}

		// Add auto_fallback_enabled column if it doesn't exist
		if (!initialAccountsColumnNames.includes("auto_fallback_enabled")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN auto_fallback_enabled INTEGER DEFAULT 0",
			).run();
			log.info("Added auto_fallback_enabled column to accounts table");
		}

		// Add custom_endpoint column if it doesn't exist
		if (!initialAccountsColumnNames.includes("custom_endpoint")) {
			db.prepare("ALTER TABLE accounts ADD COLUMN custom_endpoint TEXT").run();
			log.info("Added custom_endpoint column to accounts table");
		}

		// Add auto_refresh_enabled column if it doesn't exist
		if (!initialAccountsColumnNames.includes("auto_refresh_enabled")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN auto_refresh_enabled INTEGER DEFAULT 0",
			).run();
			log.info("Added auto_refresh_enabled column to accounts table");
		}

		// Add model_mappings column for OpenAI-compatible providers
		if (!initialAccountsColumnNames.includes("model_mappings")) {
			db.prepare("ALTER TABLE accounts ADD COLUMN model_mappings TEXT").run();
			log.info("Added model_mappings column to accounts table");
		}

		// Run API key storage migration to move API keys from refresh_token to api_key field
		// This is a data migration that should happen after all schema changes
		try {
			runApiKeyStorageMigration(db);
		} catch (error) {
			log.error(
				`API key storage migration failed: ${(error as Error).message}`,
			);
			throw error;
		}

		// Check columns in oauth_sessions table
		const oauthSessionsInfo = db
			.prepare("PRAGMA table_info(oauth_sessions)")
			.all() as Array<{
			cid: number;
			name: string;
			type: string;
			notnull: number;
			// biome-ignore lint/suspicious/noExplicitAny: SQLite pragma can return various default value types
			dflt_value: any;
			pk: number;
		}>;

		const initialOauthSessionsColumnNames = oauthSessionsInfo.map(
			(col) => col.name,
		);

		// Add custom_endpoint column to oauth_sessions if it doesn't exist
		if (!initialOauthSessionsColumnNames.includes("custom_endpoint")) {
			db.prepare(
				"ALTER TABLE oauth_sessions ADD COLUMN custom_endpoint TEXT",
			).run();
			log.info("Added custom_endpoint column to oauth_sessions table");
		}

		// Check columns in requests table
		const requestsInfo = db
			.prepare("PRAGMA table_info(requests)")
			.all() as Array<{
			cid: number;
			name: string;
			type: string;
			notnull: number;
			// biome-ignore lint/suspicious/noExplicitAny: SQLite pragma can return various default value types
			dflt_value: any;
			pk: number;
		}>;

		const requestsColumnNames = requestsInfo.map((col) => col.name);

		// Add model column if it doesn't exist
		if (!requestsColumnNames.includes("model")) {
			db.prepare("ALTER TABLE requests ADD COLUMN model TEXT").run();
			log.info("Added model column to requests table");
		}

		// Add prompt_tokens column if it doesn't exist
		if (!requestsColumnNames.includes("prompt_tokens")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN prompt_tokens INTEGER DEFAULT 0",
			).run();
			log.info("Added prompt_tokens column to requests table");
		}

		// Add completion_tokens column if it doesn't exist
		if (!requestsColumnNames.includes("completion_tokens")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN completion_tokens INTEGER DEFAULT 0",
			).run();
			log.info("Added completion_tokens column to requests table");
		}

		// Add total_tokens column if it doesn't exist
		if (!requestsColumnNames.includes("total_tokens")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN total_tokens INTEGER DEFAULT 0",
			).run();
			log.info("Added total_tokens column to requests table");
		}

		// Add cost_usd column if it doesn't exist
		if (!requestsColumnNames.includes("cost_usd")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN cost_usd REAL DEFAULT 0",
			).run();
			log.info("Added cost_usd column to requests table");
		}

		// Add input_tokens column if it doesn't exist
		if (!requestsColumnNames.includes("input_tokens")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN input_tokens INTEGER DEFAULT 0",
			).run();
			log.info("Added input_tokens column to requests table");
		}

		// Add cache_read_input_tokens column if it doesn't exist
		if (!requestsColumnNames.includes("cache_read_input_tokens")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN cache_read_input_tokens INTEGER DEFAULT 0",
			).run();
			log.info("Added cache_read_input_tokens column to requests table");
		}

		// Add cache_creation_input_tokens column if it doesn't exist
		if (!requestsColumnNames.includes("cache_creation_input_tokens")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN cache_creation_input_tokens INTEGER DEFAULT 0",
			).run();
			log.info("Added cache_creation_input_tokens column to requests table");
		}

		// Add output_tokens column if it doesn't exist
		if (!requestsColumnNames.includes("output_tokens")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN output_tokens INTEGER DEFAULT 0",
			).run();
			log.info("Added output_tokens column to requests table");
		}

		// Add agent_used column if it doesn't exist
		if (!requestsColumnNames.includes("agent_used")) {
			db.prepare("ALTER TABLE requests ADD COLUMN agent_used TEXT").run();
			log.info("Added agent_used column to requests table");
		}

		// Add output_tokens_per_second column if it doesn't exist
		if (!requestsColumnNames.includes("output_tokens_per_second")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN output_tokens_per_second REAL",
			).run();
			log.info("Added output_tokens_per_second column to requests table");
		}

		// Add api_key_id column if it doesn't exist
		if (!requestsColumnNames.includes("api_key_id")) {
			db.prepare("ALTER TABLE requests ADD COLUMN api_key_id TEXT").run();
			log.info("Added api_key_id column to requests table");
		}

		// Add api_key_name column if it doesn't exist
		if (!requestsColumnNames.includes("api_key_name")) {
			db.prepare("ALTER TABLE requests ADD COLUMN api_key_name TEXT").run();
			log.info("Added api_key_name column to requests table");
		}

		// Add performance indexes
		addPerformanceIndexes(db);

		// Remove tier columns if they exist (cleanup migration)
		// Use the column names we already defined above
		// Drop account_tier column from accounts table if it exists
		if (finalAccountsColumnNames.includes("account_tier")) {
			// SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
			db.prepare(`
			CREATE TABLE accounts_new AS
			SELECT id, name, provider, api_key, refresh_token, access_token, expires_at,
			       created_at, last_used, request_count, total_requests, priority,
			       rate_limited_until, session_start, session_request_count, paused,
			       rate_limit_reset, rate_limit_status, rate_limit_remaining,
			       auto_fallback_enabled, custom_endpoint, auto_refresh_enabled, model_mappings
			FROM accounts
		`).run();

			db.prepare(`DROP TABLE accounts`).run();
			db.prepare(`ALTER TABLE accounts_new RENAME TO accounts`).run();

			// Recreate indexes
			db.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_id ON accounts(id)`,
			).run();
			db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts(name)`,
			).run();
			db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider)`,
			).run();
			db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_accounts_priority ON accounts(priority)`,
			).run();
			db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_accounts_last_used ON accounts(last_used)`,
			).run();

			log.info("Removed account_tier column from accounts table");
		}

		// Drop tier column from oauth_sessions table if it exists
		if (finalOAuthColumnNames.includes("tier")) {
			db.prepare(`
			CREATE TABLE oauth_sessions_new AS
			SELECT id, account_name, verifier, mode, created_at, expires_at, custom_endpoint
			FROM oauth_sessions
		`).run();

			db.prepare(`DROP TABLE oauth_sessions`).run();
			db.prepare(
				`ALTER TABLE oauth_sessions_new RENAME TO oauth_sessions`,
			).run();

			// Recreate indexes
			db.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_sessions_id ON oauth_sessions(id)`,
			).run();
			db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON oauth_sessions(expires_at)`,
			).run();

			log.info("Removed tier column from oauth_sessions table");
		}

		// Update existing "max" mode values to "claude-oauth" in oauth_sessions table
		try {
			const updateCount = db
				.prepare(
					`UPDATE oauth_sessions SET mode = 'claude-oauth' WHERE mode = 'max'`,
				)
				.run().changes;
			if (updateCount > 0) {
				log.info(
					`Updated ${updateCount} oauth_sessions records from 'max' to 'claude-oauth'`,
				);
			}
		} catch (error) {
			log.warn(
				`Error updating oauth_sessions mode values: ${(error as Error).message}`,
			);
		}

		// Migrate existing Claude console accounts from 'anthropic' to 'claude-console-api' provider
		// Console accounts are identified by having an api_key (as opposed to OAuth accounts which have access_token/refresh_token)
		try {
			const updateCount = db
				.prepare(
					`UPDATE accounts SET provider = 'claude-console-api' WHERE provider = 'anthropic' AND api_key IS NOT NULL AND api_key != ''`,
				)
				.run().changes;
			if (updateCount > 0) {
				log.info(
					`Updated ${updateCount} accounts from 'anthropic' to 'claude-console-api' provider (console accounts)`,
				);
			}
		} catch (error) {
			log.warn(
				`Error updating account provider values: ${(error as Error).message}`,
			);
		}

		// Sanitize existing account names to prevent command injection
		// Replace any characters not matching /^[a-zA-Z0-9\-_]+$/ with underscores
		try {
			const accounts = db
				.prepare(`SELECT id, name FROM accounts`)
				.all() as Array<{ id: string; name: string }>;

			let sanitizedCount = 0;
			for (const account of accounts) {
				// Check if name contains any forbidden characters
				if (!/^[a-zA-Z0-9\-_]+$/.test(account.name)) {
					// Sanitize by replacing forbidden chars with underscores
					const sanitizedName = account.name.replace(/[^a-zA-Z0-9\-_]/g, "_");

					// Ensure name doesn't become duplicate
					let finalName = sanitizedName;
					let suffix = 1;
					while (
						accounts.some((a) => a.id !== account.id && a.name === finalName) ||
						(
							db
								.prepare(
									`SELECT COUNT(*) as count FROM accounts WHERE name = ?`,
								)
								.get(finalName) as { count: number }
						).count > 0
					) {
						finalName = `${sanitizedName}_${suffix}`;
						suffix++;
					}

					db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(
						finalName,
						account.id,
					);
					sanitizedCount++;
					log.info(
						`Sanitized account name: "${account.name}" -> "${finalName}"`,
					);
				}
			}

			if (sanitizedCount > 0) {
				log.info(
					`Sanitized ${sanitizedCount} account name(s) to prevent command injection`,
				);
			}
		} catch (error) {
			log.warn(`Error sanitizing account names: ${(error as Error).message}`);
		}
	});

	// Execute the migration transaction
	try {
		migrationTx();
		log.info("All database migrations completed successfully");
	} catch (error) {
		log.error(`Database migration failed: ${(error as Error).message}`);
		throw error; // Re-throw to allow calling code to handle the failure
	}
}

/**
 * Run API key storage migration to move API keys from refresh_token to api_key field
 * This ensures API keys are stored in the correct field while preserving OAuth tokens
 *
 * Migration approach: Using separate focused queries instead of a single consolidated query
 * for better maintainability, clearer logic separation, and easier debugging. Each migration
 * type (API key providers, duplicate cleanup, console accounts) has distinct criteria and purpose.
 */
export function runApiKeyStorageMigration(db: Database): void {
	try {
		// Update API-key providers to move API key from refresh_token to api_key field
		// Only if api_key is null/undefined and refresh_token contains a value
		// This handles zai, openai-compatible, minimax, and anthropic-compatible providers
		const updateSql = `
			UPDATE accounts
			SET
				api_key = refresh_token,
				refresh_token = '',
				access_token = '',
				expires_at = NULL
			WHERE
				provider IN ('zai', 'openai-compatible', 'minimax', 'anthropic-compatible')
				AND api_key IS NULL
				AND refresh_token IS NOT NULL
				AND refresh_token != ''
				AND LENGTH(refresh_token) > 0
		`;

		const result = db.prepare(updateSql).run();
		const updatedCount = (result.changes as number) || 0;
		log.debug(
			`API Key Migration: Updated ${updatedCount} API-key provider accounts from refresh_token to api_key field`,
		);

		// Also handle accounts where both api_key and refresh_token have the same value (duplicate storage)
		const cleanupSql = `
			UPDATE accounts
			SET
				refresh_token = '',
				access_token = '',
				expires_at = NULL
			WHERE
				provider IN ('zai', 'openai-compatible', 'minimax', 'anthropic-compatible')
				AND api_key IS NOT NULL
				AND refresh_token = api_key
		`;

		const cleanupResult = db.prepare(cleanupSql).run();
		const cleanupCount = (cleanupResult.changes as number) || 0;

		// Handle console accounts separately - these are anthropic provider accounts that use API keys
		// Console accounts have api_key but no access_token/refresh_token normally, but older ones might have been stored in refresh_token
		// Note: Using separate focused queries instead of a single consolidated query for better maintainability,
		// clearer logic separation, and easier debugging. Each migration type has distinct criteria and purpose.
		const consoleUpdateSql = `
			UPDATE accounts
			SET
				api_key = refresh_token,
				refresh_token = '',
				access_token = '',
				expires_at = NULL
			WHERE
				provider = 'anthropic'
				AND api_key IS NULL  -- Console accounts should have api_key, but if missing and refresh_token has value, it's likely a console account
				AND refresh_token IS NOT NULL
				AND refresh_token != ''
				AND access_token IS NULL  -- OAuth accounts have access_token, console accounts don't
				AND (
					expires_at IS NULL  -- Console accounts don't have token expiration
					OR expires_at = 0   -- Or have invalid/zero expiration
					OR expires_at < ?   -- Or expired more than 24h ago (likely not a valid OAuth token)
				)
				AND refresh_token NOT LIKE 'sk-ant-api03-%'  -- Exclude actual Anthropic OAuth refresh tokens
				AND refresh_token NOT LIKE 'sk-ant-%'        -- Exclude newer Anthropic token formats
		`;

		const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;
		const consoleResult = db.prepare(consoleUpdateSql).run(cutoffTime);
		const consoleCount = (consoleResult.changes as number) || 0;

		const totalCount = updatedCount + cleanupCount + consoleCount;
		if (totalCount > 0) {
			log.info(
				`Migrated ${totalCount} accounts to API key storage v2 (moved from refresh_token to api_key)`,
				{
					migrationVersion: 2,
					timestamp: new Date().toISOString(),
					updatedAccounts: updatedCount,
					cleanupAccounts: cleanupCount,
					consoleAccounts: consoleCount,
				},
			);
			if (updatedCount > 0) {
				log.debug(
					`  - ${updatedCount} accounts had API key moved from refresh_token to api_key`,
				);
			}
			if (cleanupCount > 0) {
				log.debug(
					`  - ${cleanupCount} accounts had duplicate API key storage cleaned up`,
				);
			}
			if (consoleCount > 0) {
				log.debug(
					`  - ${consoleCount} console accounts had API key moved from refresh_token to api_key (using enhanced detection)`,
				);
			}
		}
	} catch (error) {
		log.warn(
			`Error during API key storage migration: ${(error as Error).message}`,
		);
		// Continue with other migrations even if this one fails
	}
}
