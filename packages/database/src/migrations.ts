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
			refresh_token TEXT,
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			consecutive_rate_limits INTEGER NOT NULL DEFAULT 0
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
			agent_used TEXT,
			project TEXT,
			billing_type TEXT DEFAULT 'api'
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
			timestamp INTEGER,
			FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);

	// Index for efficient age-based payload cleanup — only if column exists
	// (may not exist if table was inherited from a legacy ccflare database)
	const payloadCols = (
		db.prepare("PRAGMA table_info(request_payloads)").all() as Array<{
			name: string;
		}>
	).map((c) => c.name);
	if (payloadCols.includes("timestamp")) {
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_request_payloads_timestamp ON request_payloads(timestamp)`,
		);
	}

	// Create oauth_sessions table for secure PKCE verifier storage
	db.run(`
		CREATE TABLE IF NOT EXISTS oauth_sessions (
			id TEXT PRIMARY KEY,
			account_name TEXT NOT NULL,
			verifier TEXT NOT NULL,
			mode TEXT NOT NULL,
			custom_endpoint TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
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

	// Create model_translations table for mapping client model names to Bedrock model IDs
	db.run(`
		CREATE TABLE IF NOT EXISTS model_translations (
			id TEXT PRIMARY KEY,
			client_name TEXT NOT NULL,
			bedrock_model_id TEXT NOT NULL,
			is_default INTEGER DEFAULT 1,
			auto_discovered INTEGER DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// Create index for fast lookups by client name
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_model_translations_client_name ON model_translations(client_name)`,
	);

	// Create unique index to prevent duplicate mappings
	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_model_translations_unique ON model_translations(client_name, bedrock_model_id)`,
	);

	// Create combos table
	db.run(`
		CREATE TABLE IF NOT EXISTS combos (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT,
			enabled INTEGER DEFAULT 1,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// Create combo_slots table
	// account_id CASCADE: deleting an account removes its slots (REQ-17)
	// combo_id CASCADE: deleting a combo removes all its slots (REQ-18)
	db.run(`
		CREATE TABLE IF NOT EXISTS combo_slots (
			id TEXT PRIMARY KEY,
			combo_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			model TEXT NOT NULL,
			priority INTEGER NOT NULL,
			enabled INTEGER DEFAULT 1,
			FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE CASCADE,
			FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
		)
	`);

	// Index for fast slot lookups by combo, ordered by priority
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_combo_slots_combo_id ON combo_slots(combo_id, priority)`,
	);

	// Unique constraint to prevent duplicate (combo_id, account_id, model) slots
	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_slots_unique ON combo_slots(combo_id, account_id, model)`,
	);

	// Create combo_family_assignments table
	// combo_id SET NULL: deleting a combo clears the family assignment without error
	db.run(`
		CREATE TABLE IF NOT EXISTS combo_family_assignments (
			family TEXT PRIMARY KEY,
			combo_id TEXT,
			enabled INTEGER DEFAULT 0,
			FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE SET NULL
		)
	`);

	// Seed the three canonical families so fresh installs have assignment rows
	db.run(`
		INSERT OR IGNORE INTO combo_family_assignments (family, combo_id, enabled)
		VALUES ('opus',   NULL, 0),
		       ('sonnet', NULL, 0),
		       ('haiku',  NULL, 0);
	`);
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

	// Query remaining tables for column existence checks needed by willModifySchema
	const requestsInfo = db
		.prepare("PRAGMA table_info(requests)")
		.all() as Array<{ name: string }>;
	const requestsColumnNames = requestsInfo.map((col) => col.name);

	const requestPayloadsInfo = db
		.prepare("PRAGMA table_info(request_payloads)")
		.all() as Array<{ name: string }>;
	const requestPayloadsColumnNames = requestPayloadsInfo.map((col) => col.name);

	const apiKeysInfo = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{
		name: string;
	}>;
	const apiKeysColumnNames = apiKeysInfo.map((col) => col.name);

	const oauthSessionsInfo = db
		.prepare("PRAGMA table_info(oauth_sessions)")
		.all() as Array<{ name: string }>;
	const initialOauthSessionsColumnNames = oauthSessionsInfo.map(
		(col) => col.name,
	);

	const refreshTokenCol = accountsInfo.find(
		(col) => col.name === "refresh_token",
	);

	// Determine if any schema modifications are needed before running migrations
	// This drives the backup decision — only backup when changes will actually occur
	const willModifySchema =
		!initialAccountsColumnNames.includes("rate_limited_until") ||
		!initialAccountsColumnNames.includes("session_start") ||
		!initialAccountsColumnNames.includes("session_request_count") ||
		!initialAccountsColumnNames.includes("paused") ||
		!initialAccountsColumnNames.includes("rate_limit_reset") ||
		!initialAccountsColumnNames.includes("rate_limit_status") ||
		!initialAccountsColumnNames.includes("rate_limit_remaining") ||
		!initialAccountsColumnNames.includes("priority") ||
		!initialAccountsColumnNames.includes("auto_fallback_enabled") ||
		!initialAccountsColumnNames.includes("custom_endpoint") ||
		!initialAccountsColumnNames.includes("auto_refresh_enabled") ||
		!initialAccountsColumnNames.includes("model_mappings") ||
		!initialAccountsColumnNames.includes("cross_region_mode") ||
		!initialAccountsColumnNames.includes("model_fallbacks") ||
		!initialAccountsColumnNames.includes("billing_type") ||
		!initialAccountsColumnNames.includes("refresh_token_issued_at") ||
		!initialAccountsColumnNames.includes("auto_pause_on_overage_enabled") ||
		!initialAccountsColumnNames.includes("peak_hours_pause_enabled") ||
		!initialAccountsColumnNames.includes("pause_reason") ||
		!initialAccountsColumnNames.includes("rate_limited_reason") ||
		!initialAccountsColumnNames.includes("rate_limited_at") ||
		(refreshTokenCol && refreshTokenCol.notnull === 1) ||
		!requestsColumnNames.includes("model") ||
		!requestsColumnNames.includes("prompt_tokens") ||
		!requestsColumnNames.includes("completion_tokens") ||
		!requestsColumnNames.includes("total_tokens") ||
		!requestsColumnNames.includes("cost_usd") ||
		!requestsColumnNames.includes("input_tokens") ||
		!requestsColumnNames.includes("cache_read_input_tokens") ||
		!requestsColumnNames.includes("cache_creation_input_tokens") ||
		!requestsColumnNames.includes("output_tokens") ||
		!requestsColumnNames.includes("agent_used") ||
		!requestsColumnNames.includes("output_tokens_per_second") ||
		!requestsColumnNames.includes("api_key_id") ||
		!requestsColumnNames.includes("api_key_name") ||
		!requestsColumnNames.includes("project") ||
		!requestsColumnNames.includes("billing_type") ||
		!requestsColumnNames.includes("combo_name") ||
		!requestPayloadsColumnNames.includes("timestamp") ||
		!apiKeysColumnNames.includes("role") ||
		!initialOauthSessionsColumnNames.includes("custom_endpoint") ||
		!initialOauthSessionsColumnNames.includes("priority") ||
		finalAccountsColumnNames.includes("account_tier") ||
		finalOAuthColumnNames.includes("tier");

	// Create backup before schema modifications
	if (willModifySchema && dbPath && dbPath !== "") {
		try {
			const absoluteSourcePath = path.resolve(dbPath);

			if (
				absoluteSourcePath.includes("../") ||
				absoluteSourcePath.includes("..\\") ||
				absoluteSourcePath.endsWith("..") ||
				absoluteSourcePath.startsWith("..")
			) {
				log.warn(`Unsafe path detected: ${dbPath}. Skipping backup.`);
			} else if (fs.existsSync(absoluteSourcePath)) {
				const stats = fs.statSync(absoluteSourcePath);
				if (!stats.isFile()) {
					log.warn(
						`Database path is not a file: ${absoluteSourcePath}. Skipping backup.`,
					);
				} else if (stats.size === 0) {
					log.debug("Database file is empty, skipping backup.");
				} else {
					const backupPath = `${absoluteSourcePath}.backup.${Date.now()}`;
					fs.copyFileSync(absoluteSourcePath, backupPath);
					log.info(`Database backup created at: ${backupPath}`);
				}
			} else {
				log.warn(
					`Database file does not exist at path: ${absoluteSourcePath}. Skipping backup.`,
				);
			}
		} catch (error) {
			log.warn(
				`Error during database backup: ${(error as Error).message}. Skipping backup.`,
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

		// Add cross_region_mode column for Bedrock cross-region inference configuration
		if (!initialAccountsColumnNames.includes("cross_region_mode")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN cross_region_mode TEXT DEFAULT 'geographic'",
			).run();
			log.info("Added cross_region_mode column to accounts table");
		}

		// Add model_fallbacks column for automatic model fallback on unavailable models
		if (!initialAccountsColumnNames.includes("model_fallbacks")) {
			db.prepare("ALTER TABLE accounts ADD COLUMN model_fallbacks TEXT").run();
			log.info("Added model_fallbacks column to accounts table");
		}

		// Add billing_type column for per-account billing classification
		if (!initialAccountsColumnNames.includes("billing_type")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN billing_type TEXT DEFAULT NULL",
			).run();
			log.info("Added billing_type column to accounts table");
		}

		// Add refresh_token_issued_at column to track when the current refresh token was last issued
		// This fixes false "token expired" reports on accounts older than 90 days (created_at is not updated on refresh)
		if (!initialAccountsColumnNames.includes("refresh_token_issued_at")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN refresh_token_issued_at INTEGER",
			).run();
			log.info("Added refresh_token_issued_at column to accounts table");
		}

		// Add auto_pause_on_overage_enabled column for Anthropic accounts
		if (!initialAccountsColumnNames.includes("auto_pause_on_overage_enabled")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN auto_pause_on_overage_enabled INTEGER DEFAULT 0",
			).run();
			log.info("Added auto_pause_on_overage_enabled column to accounts table");
		}

		// Add peak_hours_pause_enabled column for per-account Zai peak hours auto-pause
		if (!initialAccountsColumnNames.includes("peak_hours_pause_enabled")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN peak_hours_pause_enabled INTEGER NOT NULL DEFAULT 0",
			).run();
			log.info("Added peak_hours_pause_enabled column to accounts table");
		}

		// Add pause_reason column to track why an account is paused (issue #139)
		// Possible values: null (not paused), 'manual' (user paused via CLI/API),
		// 'failure_threshold' (auto-refresh failures), 'overage' (billing overage)
		if (!initialAccountsColumnNames.includes("pause_reason")) {
			db.prepare("ALTER TABLE accounts ADD COLUMN pause_reason TEXT").run();
			log.info("Added pause_reason column to accounts table");

			// Backfill existing paused accounts conservatively as manual.
			// We cannot reliably distinguish historical overage pauses from other pauses.
			db.prepare(`
				UPDATE accounts
				SET pause_reason = 'manual'
				WHERE COALESCE(paused, 0) = 1
			`).run();
			log.info("Backfilled pause_reason for existing paused accounts");
		}

		if (!initialAccountsColumnNames.includes("rate_limited_reason")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN rate_limited_reason TEXT",
			).run();
			log.info("Added rate_limited_reason column to accounts table");
		}

		if (!initialAccountsColumnNames.includes("rate_limited_at")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN rate_limited_at INTEGER",
			).run();
			log.info("Added rate_limited_at column to accounts table");
		}

		if (!initialAccountsColumnNames.includes("consecutive_rate_limits")) {
			db.prepare(
				"ALTER TABLE accounts ADD COLUMN consecutive_rate_limits INTEGER NOT NULL DEFAULT 0",
			).run();
			log.info("Added consecutive_rate_limits column to accounts table");
		}

		// Make refresh_token nullable (was NOT NULL, causing API-key providers to need workarounds)
		const refreshTokenCol = accountsInfo.find(
			(col) => col.name === "refresh_token",
		);
		if (refreshTokenCol && refreshTokenCol.notnull === 1) {
			// Table rebuild required — SQLite doesn't support ALTER COLUMN
			db.prepare(`
				CREATE TABLE accounts_new (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					provider TEXT DEFAULT 'anthropic',
					api_key TEXT,
					refresh_token TEXT,
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
					cross_region_mode TEXT DEFAULT 'geographic',
					model_fallbacks TEXT,
					auto_pause_on_overage_enabled INTEGER DEFAULT 0,
					pause_reason TEXT
				)
			`).run();

			// Copy data — convert empty-string sentinels back to NULL for API-key providers
			db.prepare(`
				INSERT INTO accounts_new SELECT
					id, name, provider, api_key,
					CASE WHEN refresh_token = '' THEN NULL ELSE refresh_token END,
					NULLIF(access_token, ''),
					expires_at, created_at, last_used,
					request_count, total_requests, priority,
					rate_limited_until, session_start, session_request_count,
					paused, rate_limit_reset, rate_limit_status, rate_limit_remaining,
					auto_fallback_enabled, custom_endpoint, auto_refresh_enabled,
					model_mappings, cross_region_mode, model_fallbacks,
					auto_pause_on_overage_enabled, pause_reason
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

			log.info("Made refresh_token nullable in accounts table");
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

		// Add custom_endpoint column to oauth_sessions if it doesn't exist
		if (!initialOauthSessionsColumnNames.includes("custom_endpoint")) {
			db.prepare(
				"ALTER TABLE oauth_sessions ADD COLUMN custom_endpoint TEXT",
			).run();
			log.info("Added custom_endpoint column to oauth_sessions table");
		}

		// Add priority column to oauth_sessions if it doesn't exist
		if (!initialOauthSessionsColumnNames.includes("priority")) {
			db.prepare(
				"ALTER TABLE oauth_sessions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
			).run();
			log.info("Added priority column to oauth_sessions table");
		}

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

		// Add project column if it doesn't exist
		if (!requestsColumnNames.includes("project")) {
			db.prepare("ALTER TABLE requests ADD COLUMN project TEXT").run();
			log.info("Added project column to requests table");
		}

		// Add billing_type column if it doesn't exist
		if (!requestsColumnNames.includes("billing_type")) {
			db.prepare(
				"ALTER TABLE requests ADD COLUMN billing_type TEXT DEFAULT 'api'",
			).run();
			log.info("Added billing_type column to requests table");
		}

		// Add combo_name column if it doesn't exist
		if (!requestsColumnNames.includes("combo_name")) {
			db.prepare("ALTER TABLE requests ADD COLUMN combo_name TEXT").run();
			log.info("Added combo_name column to requests table");
		}

		// Add timestamp column to request_payloads if it doesn't exist
		if (!requestPayloadsColumnNames.includes("timestamp")) {
			db.prepare(
				"ALTER TABLE request_payloads ADD COLUMN timestamp INTEGER",
			).run();
			// Backfill timestamps from the requests table for existing rows
			db.prepare(`
				UPDATE request_payloads
				SET timestamp = (SELECT timestamp FROM requests WHERE requests.id = request_payloads.id)
				WHERE timestamp IS NULL
			`).run();
			// Create index for efficient age-based cleanup
			db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_request_payloads_timestamp ON request_payloads(timestamp)`,
			).run();
			log.info(
				"Added timestamp column to request_payloads table and backfilled from requests",
			);
		}

		// Add role column to api_keys if it doesn't exist (Migration v4)
		if (!apiKeysColumnNames.includes("role")) {
			// Add column with default value
			db.prepare(
				"ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'api-only'",
			).run();
			log.info("Added role column to api_keys table");

			// Update existing keys to 'admin' for backwards compatibility
			const updateResult = db
				.prepare("UPDATE api_keys SET role = 'admin' WHERE role = 'api-only'")
				.run();
			const updatedCount = (updateResult.changes as number) || 0;
			if (updatedCount > 0) {
				log.info(
					`Updated ${updatedCount} existing API key(s) to 'admin' role for backwards compatibility`,
				);
			}

			// Create index on role column
			db.prepare(
				"CREATE INDEX IF NOT EXISTS idx_api_keys_role ON api_keys(role)",
			).run();
			log.info("Created index on api_keys role column");
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
			       auto_fallback_enabled, custom_endpoint, auto_refresh_enabled, model_mappings,
			       cross_region_mode, model_fallbacks, billing_type, auto_pause_on_overage_enabled,
			       pause_reason
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
			// Relies on the priority ADD COLUMN above having run earlier in this
			// same transaction; do not reorder these blocks.
			//
			// IMPORTANT: explicitly recreate the target schema with all constraints
			// (PRIMARY KEY, NOT NULL, DEFAULT) — `CREATE TABLE ... AS SELECT ...`
			// only copies column types, dropping every constraint. Keep this in
			// sync with the oauth_sessions definition in ensureSchema().
			db.prepare(`
				CREATE TABLE oauth_sessions_new (
					id TEXT PRIMARY KEY,
					account_name TEXT NOT NULL,
					verifier TEXT NOT NULL,
					mode TEXT NOT NULL,
					custom_endpoint TEXT,
					priority INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL,
					expires_at INTEGER NOT NULL
				)
			`).run();

			db.prepare(`
				INSERT INTO oauth_sessions_new (id, account_name, verifier, mode, custom_endpoint, priority, created_at, expires_at)
				SELECT id, account_name, verifier, mode, custom_endpoint, priority, created_at, expires_at
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

		// Populate default Claude model translations for Bedrock
		// Use INSERT OR IGNORE to allow safe re-runs
		const now = Date.now();
		const defaultMappings = [
			// Dated models
			{
				id: "model-trans-1",
				client: "claude-3-5-sonnet-20241022",
				bedrock: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			},
			{
				id: "model-trans-2",
				client: "claude-3-5-sonnet-20240620",
				bedrock: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
			},
			{
				id: "model-trans-3",
				client: "claude-3-5-haiku-20241022",
				bedrock: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
			},
			{
				id: "model-trans-4",
				client: "claude-3-opus-20240229",
				bedrock: "us.anthropic.claude-3-opus-20240229-v1:0",
			},
			{
				id: "model-trans-5",
				client: "claude-3-sonnet-20240229",
				bedrock: "us.anthropic.claude-3-sonnet-20240229-v1:0",
			},
			{
				id: "model-trans-6",
				client: "claude-3-haiku-20240307",
				bedrock: "us.anthropic.claude-3-haiku-20240307-v1:0",
			},
			// Convenience aliases (point to latest versions)
			{
				id: "model-trans-7",
				client: "claude-3-5-sonnet",
				bedrock: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			},
			{
				id: "model-trans-8",
				client: "claude-3-5-haiku",
				bedrock: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
			},
			{
				id: "model-trans-9",
				client: "claude-3-opus",
				bedrock: "us.anthropic.claude-3-opus-20240229-v1:0",
			},
			{
				id: "model-trans-10",
				client: "claude-3-sonnet",
				bedrock: "us.anthropic.claude-3-sonnet-20240229-v1:0",
			},
			{
				id: "model-trans-11",
				client: "claude-3-haiku",
				bedrock: "us.anthropic.claude-3-haiku-20240307-v1:0",
			},
		];

		for (const mapping of defaultMappings) {
			db.prepare(
				`INSERT OR IGNORE INTO model_translations (id, client_name, bedrock_model_id, is_default, auto_discovered, created_at, updated_at)
				 VALUES (?, ?, ?, 1, 0, ?, ?)`,
			).run(mapping.id, mapping.client, mapping.bedrock, now, now);
		}

		const insertedCount = defaultMappings.length;
		log.info(
			`Populated ${insertedCount} default Claude model translations for Bedrock`,
		);
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
				refresh_token = NULL,
				access_token = NULL,
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
				refresh_token = NULL,
				access_token = NULL,
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
				refresh_token = NULL,
				access_token = NULL,
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
