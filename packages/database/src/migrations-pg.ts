import { Logger } from "@better-ccflare/logger";
import type { BunSqlAdapter } from "./adapters/bun-sql-adapter";

const log = new Logger("DatabaseMigrations-PG");

/**
 * Check if a column exists in a PostgreSQL table using information_schema
 */
async function columnExists(
	adapter: BunSqlAdapter,
	table: string,
	column: string,
): Promise<boolean> {
	const result = await adapter.get<{ exists: number }>(
		`SELECT COUNT(*) as exists
		 FROM information_schema.columns
		 WHERE table_name = ? AND column_name = ?`,
		[table, column],
	);
	return (result?.exists ?? 0) > 0;
}

/**
 * Check if a table exists in PostgreSQL
 */
async function _tableExists(
	adapter: BunSqlAdapter,
	table: string,
): Promise<boolean> {
	const result = await adapter.get<{ exists: number }>(
		`SELECT COUNT(*) as exists
		 FROM information_schema.tables
		 WHERE table_name = ?`,
		[table],
	);
	return (result?.exists ?? 0) > 0;
}

/**
 * Ensure the full schema exists for PostgreSQL
 */
export async function ensureSchemaPg(adapter: BunSqlAdapter): Promise<void> {
	// Create accounts table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT,
			access_token TEXT,
			expires_at BIGINT,
			created_at BIGINT NOT NULL,
			last_used BIGINT,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			rate_limited_until BIGINT,
			session_start BIGINT,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset BIGINT,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			auto_fallback_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			auto_refresh_enabled INTEGER DEFAULT 0,
			model_mappings TEXT,
			model_fallbacks TEXT,
			cross_region_mode TEXT DEFAULT 'geographic',
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			peak_hours_pause_enabled INTEGER NOT NULL DEFAULT 0,
			pause_reason TEXT,
			billing_type TEXT DEFAULT NULL,
			refresh_token_issued_at BIGINT,
			rate_limited_reason TEXT,
			rate_limited_at BIGINT,
			consecutive_rate_limits INTEGER NOT NULL DEFAULT 0
		)
	`);

	// Create requests table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS requests (
			id TEXT PRIMARY KEY,
			timestamp BIGINT NOT NULL,
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
			api_key_id TEXT,
			api_key_name TEXT,
			project TEXT,
			billing_type TEXT DEFAULT 'api',
			combo_name TEXT
		)
	`);

	// Create indexes for requests
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC)`,
	);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_requests_account_used ON requests(account_used)`,
	);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_requests_timestamp_account ON requests(timestamp DESC, account_used)`,
	);

	// Create request_payloads table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS request_payloads (
			id TEXT PRIMARY KEY,
			json TEXT NOT NULL,
			timestamp BIGINT,
			FOREIGN KEY (id) REFERENCES requests(id) ON DELETE CASCADE
		)
	`);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_request_payloads_timestamp ON request_payloads(timestamp)`,
	);

	// Create oauth_sessions table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS oauth_sessions (
			id TEXT PRIMARY KEY,
			account_name TEXT NOT NULL,
			verifier TEXT NOT NULL,
			mode TEXT NOT NULL,
			custom_endpoint TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
			created_at BIGINT NOT NULL,
			expires_at BIGINT NOT NULL
		)
	`);

	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON oauth_sessions(expires_at)`,
	);

	// Create agent_preferences table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS agent_preferences (
			agent_id TEXT PRIMARY KEY,
			model TEXT NOT NULL,
			updated_at BIGINT NOT NULL
		)
	`);

	// Create api_keys table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			hashed_key TEXT NOT NULL UNIQUE,
			prefix_last_8 TEXT NOT NULL,
			created_at BIGINT NOT NULL,
			last_used BIGINT,
			usage_count INTEGER DEFAULT 0,
			is_active INTEGER DEFAULT 1,
			role TEXT NOT NULL DEFAULT 'api-only'
		)
	`);

	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_api_keys_hashed_key ON api_keys(hashed_key)`,
	);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)`,
	);

	// Create model_translations table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS model_translations (
			id TEXT PRIMARY KEY,
			client_name TEXT NOT NULL,
			bedrock_model_id TEXT NOT NULL,
			is_default INTEGER DEFAULT 1,
			auto_discovered INTEGER DEFAULT 0,
			created_at BIGINT NOT NULL,
			updated_at BIGINT NOT NULL
		)
	`);

	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_model_translations_client_name ON model_translations(client_name)`,
	);
	await adapter.unsafe(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_model_translations_unique ON model_translations(client_name, bedrock_model_id)`,
	);

	// Create combos table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS combos (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT,
			enabled INTEGER DEFAULT 1,
			created_at BIGINT NOT NULL,
			updated_at BIGINT NOT NULL
		)
	`);

	// Create combo_slots table
	await adapter.unsafe(`
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
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_combo_slots_combo_id ON combo_slots(combo_id, priority)`,
	);
	await adapter.unsafe(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_slots_unique ON combo_slots(combo_id, account_id, model)`,
	);

	// Create combo_family_assignments table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS combo_family_assignments (
			family TEXT PRIMARY KEY,
			combo_id TEXT,
			enabled INTEGER DEFAULT 0,
			FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE SET NULL
		)
	`);

	// Seed canonical families
	await adapter.unsafe(`
		INSERT INTO combo_family_assignments (family, combo_id, enabled)
		VALUES ('opus', NULL, 0), ('sonnet', NULL, 0), ('haiku', NULL, 0)
		ON CONFLICT (family) DO NOTHING
	`);

	// Create strategies table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS strategies (
			name TEXT PRIMARY KEY,
			config TEXT NOT NULL,
			updated_at BIGINT NOT NULL
		)
	`);

	log.info("PostgreSQL schema ensured");
}

/**
 * Run PostgreSQL-specific migrations
 */
export async function runMigrationsPg(adapter: BunSqlAdapter): Promise<void> {
	// Add columns that might be missing from older schema versions
	const columnsToAdd: Array<{
		table: string;
		column: string;
		definition: string;
	}> = [
		{
			table: "accounts",
			column: "cross_region_mode",
			definition:
				"ALTER TABLE accounts ADD COLUMN cross_region_mode TEXT DEFAULT 'geographic'",
		},
		{
			table: "accounts",
			column: "model_mappings",
			definition: "ALTER TABLE accounts ADD COLUMN model_mappings TEXT",
		},
		{
			table: "accounts",
			column: "model_fallbacks",
			definition: "ALTER TABLE accounts ADD COLUMN model_fallbacks TEXT",
		},
		{
			table: "accounts",
			column: "billing_type",
			definition:
				"ALTER TABLE accounts ADD COLUMN billing_type TEXT DEFAULT NULL",
		},
		{
			table: "accounts",
			column: "auto_pause_on_overage_enabled",
			definition:
				"ALTER TABLE accounts ADD COLUMN auto_pause_on_overage_enabled INTEGER DEFAULT 0",
		},
		{
			table: "accounts",
			column: "auto_refresh_enabled",
			definition:
				"ALTER TABLE accounts ADD COLUMN auto_refresh_enabled INTEGER DEFAULT 0",
		},
		{
			table: "accounts",
			column: "refresh_token_issued_at",
			definition:
				"ALTER TABLE accounts ADD COLUMN refresh_token_issued_at BIGINT",
		},
		{
			table: "accounts",
			column: "rate_limited_reason",
			definition: "ALTER TABLE accounts ADD COLUMN rate_limited_reason TEXT",
		},
		{
			table: "accounts",
			column: "rate_limited_at",
			definition: "ALTER TABLE accounts ADD COLUMN rate_limited_at BIGINT",
		},
		{
			table: "accounts",
			column: "consecutive_rate_limits",
			definition:
				"ALTER TABLE accounts ADD COLUMN consecutive_rate_limits INTEGER NOT NULL DEFAULT 0",
		},
		{
			table: "requests",
			column: "api_key_id",
			definition: "ALTER TABLE requests ADD COLUMN api_key_id TEXT",
		},
		{
			table: "requests",
			column: "api_key_name",
			definition: "ALTER TABLE requests ADD COLUMN api_key_name TEXT",
		},
		{
			table: "api_keys",
			column: "role",
			definition:
				"ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'api-only'",
		},
		{
			table: "requests",
			column: "project",
			definition: "ALTER TABLE requests ADD COLUMN project TEXT",
		},
		{
			table: "accounts",
			column: "peak_hours_pause_enabled",
			definition:
				"ALTER TABLE accounts ADD COLUMN peak_hours_pause_enabled INTEGER NOT NULL DEFAULT 0",
		},
		{
			table: "accounts",
			column: "pause_reason",
			definition: "ALTER TABLE accounts ADD COLUMN pause_reason TEXT",
		},
		{
			table: "requests",
			column: "billing_type",
			definition:
				"ALTER TABLE requests ADD COLUMN billing_type TEXT DEFAULT 'api'",
		},
		{
			table: "requests",
			column: "combo_name",
			definition: "ALTER TABLE requests ADD COLUMN combo_name TEXT",
		},
		{
			table: "request_payloads",
			column: "timestamp",
			definition: "ALTER TABLE request_payloads ADD COLUMN timestamp BIGINT",
		},
		{
			table: "oauth_sessions",
			column: "custom_endpoint",
			definition: "ALTER TABLE oauth_sessions ADD COLUMN custom_endpoint TEXT",
		},
		{
			table: "oauth_sessions",
			column: "priority",
			definition:
				"ALTER TABLE oauth_sessions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
		},
	];

	for (const col of columnsToAdd) {
		const exists = await columnExists(adapter, col.table, col.column);
		if (!exists) {
			try {
				await adapter.unsafe(col.definition);
				log.info(`Added column ${col.table}.${col.column}`);
			} catch (error) {
				log.warn(
					`Could not add column ${col.table}.${col.column}: ${(error as Error).message}`,
				);
			}
		}
	}

	// Backfill pause_reason for existing paused accounts (mirrors SQLite migration)
	await adapter.unsafe(`
		UPDATE accounts
		SET pause_reason = 'manual'
		WHERE COALESCE(paused, 0) = 1 AND pause_reason IS NULL
	`);

	// Backfill request_payloads.timestamp from requests table
	await adapter.unsafe(`
		UPDATE request_payloads rp
		SET timestamp = r.timestamp
		FROM requests r
		WHERE r.id = rp.id AND rp.timestamp IS NULL
	`);

	// Ensure index on request_payloads.timestamp exists
	try {
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_request_payloads_timestamp ON request_payloads(timestamp)`,
		);
	} catch (_error) {
		// Index may already exist
	}

	// Ensure combos tables exist (for upgrades from pre-combos installs)
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS combos (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			description TEXT,
			enabled INTEGER DEFAULT 1,
			created_at BIGINT NOT NULL,
			updated_at BIGINT NOT NULL
		)
	`);
	await adapter.unsafe(`
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
	try {
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_combo_slots_combo_id ON combo_slots(combo_id, priority)`,
		);
		await adapter.unsafe(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_combo_slots_unique ON combo_slots(combo_id, account_id, model)`,
		);
	} catch (_error) {
		// Indexes may already exist
	}
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS combo_family_assignments (
			family TEXT PRIMARY KEY,
			combo_id TEXT,
			enabled INTEGER DEFAULT 0,
			FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE SET NULL
		)
	`);
	await adapter.unsafe(`
		INSERT INTO combo_family_assignments (family, combo_id, enabled)
		VALUES ('opus', NULL, 0), ('sonnet', NULL, 0), ('haiku', NULL, 0)
		ON CONFLICT (family) DO NOTHING
	`);

	// Rename oauth_sessions.mode 'max' → 'claude-oauth'
	try {
		await adapter.unsafe(
			`UPDATE oauth_sessions SET mode = 'claude-oauth' WHERE mode = 'max'`,
		);
	} catch (_error) {
		// Table may not exist yet or column missing — ignore
	}

	// Migrate console accounts: provider 'anthropic' with api_key → 'claude-console-api'
	try {
		await adapter.unsafe(`
			UPDATE accounts
			SET provider = 'claude-console-api'
			WHERE provider = 'anthropic' AND api_key IS NOT NULL AND api_key != ''
		`);
	} catch (_error) {
		// Ignore if fails
	}

	// Make refresh_token nullable if it currently has NOT NULL constraint
	try {
		await adapter.unsafe(
			`ALTER TABLE accounts ALTER COLUMN refresh_token DROP NOT NULL`,
		);
		log.info("Made refresh_token nullable in accounts table");
	} catch (_error) {
		// Already nullable or column doesn't exist — ignore
	}

	// Clean up empty-string sentinels left by old migration
	await adapter.unsafe(`
		UPDATE accounts
		SET refresh_token = NULL
		WHERE refresh_token = ''
	`);

	// Populate default model translations if not present
	const now = Date.now();
	const defaultMappings = [
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
		await adapter.run(
			`INSERT INTO model_translations (id, client_name, bedrock_model_id, is_default, auto_discovered, created_at, updated_at)
			 VALUES (?, ?, ?, 1, 0, ?, ?)
			 ON CONFLICT (client_name, bedrock_model_id) DO NOTHING`,
			[mapping.id, mapping.client, mapping.bedrock, now, now],
		);
	}

	log.info("PostgreSQL migrations completed");
}
