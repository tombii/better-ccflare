import { Logger } from "@better-ccflare/logger";
import type { BunSqlAdapter } from "./adapters/bun-sql-adapter";

const log = new Logger("DatabaseMigrations-PG");

/**
 * PostgreSQL SQLSTATE for duplicate_column. Bun's `Bun.SQL` PostgresError
 * surfaces the raw Postgres SQLSTATE code on `.code` (there is no separate
 * `sqlState` field, unlike the MySQL error class), so this is safe to match
 * directly rather than sniffing the error message.
 */
const PG_DUPLICATE_COLUMN = "42701";

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
			requires_reauth INTEGER DEFAULT 0,
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
			combo_name TEXT,
			original_model TEXT,
			applied_model TEXT,
			project_attribution_source TEXT,
			agent_attribution_source TEXT
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

	// Create alerts table
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS alerts (
			id TEXT PRIMARY KEY,
			timestamp BIGINT NOT NULL,
			type TEXT NOT NULL,
			severity TEXT NOT NULL,
			title TEXT NOT NULL,
			message TEXT NOT NULL,
			value DOUBLE PRECISION,
			threshold DOUBLE PRECISION,
			account TEXT,
			model TEXT,
			project TEXT,
			request_id TEXT,
			acknowledged INTEGER NOT NULL DEFAULT 0
		)
	`);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC)`,
	);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged)`,
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
		VALUES ('fable', NULL, 0), ('opus', NULL, 0), ('sonnet', NULL, 0), ('haiku', NULL, 0)
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

	// Create usage_snapshots table (see SQLite migration for rationale).
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS usage_snapshots (
			account_id TEXT NOT NULL,
			timestamp BIGINT NOT NULL,
			window_key TEXT NOT NULL,
			utilization DOUBLE PRECISION NOT NULL,
			resets_at BIGINT
		)
	`);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_acct_win_time ON usage_snapshots(account_id, window_key, timestamp DESC)`,
	);
	// Secondary index on timestamp alone for retention pruning (see SQLite migration).
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_ts ON usage_snapshots(timestamp)`,
	);

	log.info("PostgreSQL schema ensured");
}

/**
 * A column to add to an existing table, expressed as an ALTER TABLE
 * definition (used by the ADD COLUMN backfill loop in runMigrationsPg).
 */
interface ColumnToAdd {
	table: string;
	column: string;
	definition: string;
}

/**
 * Run a single ADD COLUMN migration, tolerating only the expected
 * concurrent-instance race (another process winning the race to add the
 * same column, surfaced as SQLSTATE 42701 duplicate_column). Any other
 * failure (permissions, lock timeout, etc) is rethrown so startup aborts
 * loudly instead of silently continuing with a missing column that later
 * writes (e.g. RequestRepository) would fail against on every request.
 *
 * Exported for testing.
 */
export async function addColumnTolerant(
	adapter: BunSqlAdapter,
	col: ColumnToAdd,
): Promise<void> {
	try {
		await adapter.unsafe(col.definition);
		log.info(`Added column ${col.table}.${col.column}`);
	} catch (error) {
		const code = (error as { code?: string } | undefined)?.code;
		if (code !== PG_DUPLICATE_COLUMN) {
			// Not the known duplicate-column race: a genuine failure
			// (permissions, lock timeout, etc). Don't swallow it, a
			// missing column here means unconditional inserts against
			// it (e.g. RequestRepository) will fail on every write.
			throw error;
		}
		// Another instance won the race to add this column concurrently.
		// Re-verify it actually landed before treating this as a no-op.
		const nowExists = await columnExists(adapter, col.table, col.column);
		if (!nowExists) {
			throw error;
		}
		log.info(
			`Column ${col.table}.${col.column} already added by a concurrent migration`,
		);
	}
}

/**
 * Collapse duplicate `(name, provider, COALESCE(custom_endpoint,''))` rows in
 * the PostgreSQL `accounts` table into a single survivor per tuple, while
 * preserving as much working account state as possible. Mirrors the SQLite
 * helper `collapseAccountDuplicatesPreservingState` in semantics; differs
 * only in (a) using PostgreSQL's `ctid` as the row-ordering tiebreak
 * (PG's analogue of SQLite's `rowid`) and (b) using the async adapter API.
 *
 * Survivor selection (deterministic, stable across rows):
 *   1. Most recent `last_used`.
 *   2. Most recent `refresh_token_issued_at`.
 *   3. Most recent `created_at`.
 *   4. Smallest `ctid` (final tiebreak — older insert wins on full ties).
 *
 * State that is merged into the survivor before the discarded rows are
 * deleted (see SQLite helper for the full rationale and column-by-column
 * rules). Dependent rows are repointed at the survivor's id before the
 * account row is removed: `combo_slots.account_id`, `requests.account_used`,
 * `usage_snapshots.account_id`. `combo_slots.account_id` has a real
 * `ON DELETE CASCADE` FK, so without this repointing we would silently
 * delete combo configurations. `requests.account_used` and
 * `usage_snapshots.account_id` are plain TEXT columns with no FK, so
 * without this repointing the request history would orphan.
 *
 * Idempotent — a no-op on already-deduped accounts.
 */
async function collapseAccountDuplicatesPreservingStatePg(
	adapter: BunSqlAdapter,
): Promise<void> {
	// Find every tuple with > 1 row. COALESCE(custom_endpoint,'') is the
	// canonical form of the future UNIQUE index, matching the SQLite path.
	// adapter.get returns one row; we need all groups — use unsafe.
	const groups = (await adapter.unsafe(
		`SELECT name, provider, COALESCE(custom_endpoint, '') AS ep
		 FROM accounts
		 GROUP BY name, provider, COALESCE(custom_endpoint, '')
		 HAVING COUNT(*) > 1`,
	)) as Array<{ name: string; provider: string; ep: string }>;
	if (groups.length === 0) {
		return;
	}

	let totalDeleted = 0;
	let totalRepointedSlots = 0;
	let totalRepointedRequests = 0;
	let totalRepointedSnapshots = 0;

	for (const grp of groups) {
		// Pick the survivor per tuple group.
		const survivorRows = (await adapter.unsafe(
			`SELECT id FROM accounts
			 WHERE name = $1 AND provider = $2 AND COALESCE(custom_endpoint, '') = $3
			 ORDER BY
			   COALESCE(last_used, 0) DESC,
			   COALESCE(refresh_token_issued_at, 0) DESC,
			   created_at DESC,
			   ctid::text ASC
			 LIMIT 1`,
			[grp.name, grp.provider, grp.ep],
		)) as Array<{ id: string }>;
		const survivor = survivorRows[0];
		if (!survivor) {
			continue;
		}

		// Pull discarded ids for this tuple group.
		const discardedRows = (await adapter.unsafe(
			`SELECT id FROM accounts
			 WHERE name = $1 AND provider = $2 AND COALESCE(custom_endpoint, '') = $3
			   AND id <> $4`,
			[grp.name, grp.provider, grp.ep, survivor.id],
		)) as Array<{ id: string }>;
		const discardedIds = discardedRows.map((r) => r.id);

		// Best (most-recently-issued) credentials from any row in the group.
		const mergedRows = (await adapter.unsafe(
			`SELECT
			   (SELECT refresh_token FROM accounts
			    WHERE name = $1 AND provider = $2 AND COALESCE(custom_endpoint, '') = $3
			      AND refresh_token IS NOT NULL AND refresh_token <> ''
			    ORDER BY COALESCE(refresh_token_issued_at, 0) DESC, ctid::text ASC
			    LIMIT 1) AS merged_refresh_token,
			   (SELECT access_token FROM accounts
			    WHERE name = $1 AND provider = $2 AND COALESCE(custom_endpoint, '') = $3
			      AND access_token IS NOT NULL AND access_token <> ''
			    ORDER BY COALESCE(refresh_token_issued_at, 0) DESC, ctid::text ASC
			    LIMIT 1) AS merged_access_token,
			   (SELECT expires_at FROM accounts
			    WHERE name = $1 AND provider = $2 AND COALESCE(custom_endpoint, '') = $3
			      AND expires_at IS NOT NULL
			    ORDER BY COALESCE(refresh_token_issued_at, 0) DESC, ctid::text ASC
			    LIMIT 1) AS merged_expires_at,
			   (SELECT api_key FROM accounts
			    WHERE name = $1 AND provider = $2 AND COALESCE(custom_endpoint, '') = $3
			      AND api_key IS NOT NULL AND api_key <> ''
			    ORDER BY COALESCE(refresh_token_issued_at, 0) DESC, created_at DESC, ctid::text ASC
			    LIMIT 1) AS merged_api_key`,
			[grp.name, grp.provider, grp.ep],
		)) as Array<{
			merged_refresh_token: string | null;
			merged_access_token: string | null;
			merged_expires_at: string | null;
			merged_api_key: string | null;
		}>;
		const merged = mergedRows[0] ?? {
			merged_refresh_token: null,
			merged_access_token: null,
			merged_expires_at: null,
			merged_api_key: null,
		};

		// Merge aggregates into the survivor. Parameter slots $1..$4 carry
		// the credential pre-fills; $5..$34 are the per-aggregate (group
		// triple + max/min/sum) lookups (10 aggregates × 3 group keys);
		// $35 is the survivor id.
		await adapter.unsafe(
			`UPDATE accounts SET
			   refresh_token = $1,
			   access_token = $2,
			   expires_at = $3::BIGINT,
			   refresh_token_issued_at = (SELECT MAX(COALESCE(refresh_token_issued_at, 0)) FROM accounts
			                              WHERE name = $5 AND provider = $6 AND COALESCE(custom_endpoint, '') = $7),
			   api_key = COALESCE(api_key, $4),
			   last_used = (SELECT MAX(COALESCE(last_used, 0)) FROM accounts
			                WHERE name = $8 AND provider = $9 AND COALESCE(custom_endpoint, '') = $10),
			   created_at = (SELECT MIN(created_at) FROM accounts
			                 WHERE name = $11 AND provider = $12 AND COALESCE(custom_endpoint, '') = $13),
			   request_count = (SELECT SUM(COALESCE(request_count, 0)) FROM accounts
			                    WHERE name = $14 AND provider = $15 AND COALESCE(custom_endpoint, '') = $16),
			   total_requests = (SELECT SUM(COALESCE(total_requests, 0)) FROM accounts
			                     WHERE name = $17 AND provider = $18 AND COALESCE(custom_endpoint, '') = $19),
			   session_request_count = (SELECT SUM(COALESCE(session_request_count, 0)) FROM accounts
			                            WHERE name = $20 AND provider = $21 AND COALESCE(custom_endpoint, '') = $22),
			   priority = (SELECT MAX(COALESCE(priority, 0)) FROM accounts
			               WHERE name = $23 AND provider = $24 AND COALESCE(custom_endpoint, '') = $25),
			   consecutive_rate_limits = (SELECT MAX(COALESCE(consecutive_rate_limits, 0)) FROM accounts
			                              WHERE name = $26 AND provider = $27 AND COALESCE(custom_endpoint, '') = $28),
			   paused = (SELECT MAX(COALESCE(paused, 0)) FROM accounts
			             WHERE name = $29 AND provider = $30 AND COALESCE(custom_endpoint, '') = $31),
			   requires_reauth = (SELECT MAX(COALESCE(requires_reauth, 0)) FROM accounts
			                      WHERE name = $32 AND provider = $33 AND COALESCE(custom_endpoint, '') = $34)
			 WHERE id = $35`,
			[
				merged.merged_refresh_token,
				merged.merged_access_token,
				merged.merged_expires_at,
				merged.merged_api_key,
				grp.name, grp.provider, grp.ep, // $5..$7
				grp.name, grp.provider, grp.ep, // $8..$10
				grp.name, grp.provider, grp.ep, // $11..$13
				grp.name, grp.provider, grp.ep, // $14..$16
				grp.name, grp.provider, grp.ep, // $17..$19
				grp.name, grp.provider, grp.ep, // $20..$22
				grp.name, grp.provider, grp.ep, // $23..$25
				grp.name, grp.provider, grp.ep, // $26..$28
				grp.name, grp.provider, grp.ep, // $29..$31
				grp.name, grp.provider, grp.ep, // $32..$34
				survivor.id, // $35
			],
		);

		if (discardedIds.length > 0) {
			// For the repointing UPDATEs the survivor id is $1 and the
			// discarded ids fill $2..$N. Build the IN-list placeholder
			// list once and reuse it across all three repoint targets.
			const idListPlaceholders = discardedIds
				.map((_, i) => `$${i + 2}`)
				.join(",");
			const repointSlots = await adapter.runWithChanges(
				`UPDATE combo_slots SET account_id = $1 WHERE account_id IN (${idListPlaceholders})`,
				[survivor.id, ...discardedIds],
			);
			const repointRequests = await adapter.runWithChanges(
				`UPDATE requests SET account_used = $1 WHERE account_used IN (${idListPlaceholders})`,
				[survivor.id, ...discardedIds],
			);
			const repointSnapshots = await adapter.runWithChanges(
				`UPDATE usage_snapshots SET account_id = $1 WHERE account_id IN (${idListPlaceholders})`,
				[survivor.id, ...discardedIds],
			);

			const idPlaceholders = discardedIds
				.map((_, i) => `$${i + 1}`)
				.join(",");
			const deleted = await adapter.runWithChanges(
				`DELETE FROM accounts WHERE id IN (${idPlaceholders})`,
				discardedIds,
			);

			totalDeleted += deleted;
			totalRepointedSlots += repointSlots;
			totalRepointedRequests += repointRequests;
			totalRepointedSnapshots += repointSnapshots;
		}
	}

	if (totalDeleted > 0) {
		log.warn(
			`Collapsed ${totalDeleted} duplicate account row(s) across ${groups.length} ` +
				`(name, provider, COALESCE(custom_endpoint,'')) tuple group(s) before creating ` +
				`UNIQUE index. Each group kept the row with the freshest credentials ` +
				`(most recent last_used → refresh_token_issued_at → created_at → smallest ctid) ` +
				`and merged request counts / priority / paused state from the rest. ` +
				`Repointed ${totalRepointedSlots} combo slot(s), ${totalRepointedRequests} ` +
				`request-history row(s), and ${totalRepointedSnapshots} usage-snapshot row(s) ` +
				`to the surviving account ids.`,
		);
	}
}

/**
 * Run PostgreSQL-specific migrations
 */
export async function runMigrationsPg(adapter: BunSqlAdapter): Promise<void> {
	// Add columns that might be missing from older schema versions
	const columnsToAdd: ColumnToAdd[] = [
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
			table: "accounts",
			column: "requires_reauth",
			definition:
				"ALTER TABLE accounts ADD COLUMN requires_reauth INTEGER DEFAULT 0",
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
			table: "requests",
			column: "original_model",
			definition: "ALTER TABLE requests ADD COLUMN original_model TEXT",
		},
		{
			table: "requests",
			column: "applied_model",
			definition: "ALTER TABLE requests ADD COLUMN applied_model TEXT",
		},
		{
			table: "requests",
			column: "project_attribution_source",
			definition:
				"ALTER TABLE requests ADD COLUMN project_attribution_source TEXT",
		},
		{
			table: "requests",
			column: "agent_attribution_source",
			definition:
				"ALTER TABLE requests ADD COLUMN agent_attribution_source TEXT",
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
			await addColumnTolerant(adapter, col);
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

	// Ensure alerts table exists (for upgrades from pre-alerts installs)
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS alerts (
			id TEXT PRIMARY KEY,
			timestamp BIGINT NOT NULL,
			type TEXT NOT NULL,
			severity TEXT NOT NULL,
			title TEXT NOT NULL,
			message TEXT NOT NULL,
			value DOUBLE PRECISION,
			threshold DOUBLE PRECISION,
			account TEXT,
			model TEXT,
			project TEXT,
			request_id TEXT,
			acknowledged INTEGER NOT NULL DEFAULT 0
		)
	`);
	try {
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC)`,
		);
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged)`,
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
		VALUES ('fable', NULL, 0), ('opus', NULL, 0), ('sonnet', NULL, 0), ('haiku', NULL, 0)
		ON CONFLICT (family) DO NOTHING
	`);

	// Ensure usage_snapshots table exists (for upgrades from pre-usage-history installs)
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS usage_snapshots (
			account_id TEXT NOT NULL,
			timestamp BIGINT NOT NULL,
			window_key TEXT NOT NULL,
			utilization DOUBLE PRECISION NOT NULL,
			resets_at BIGINT
		)
	`);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_acct_win_time ON usage_snapshots(account_id, window_key, timestamp DESC)`,
	);
	// Secondary index on timestamp alone for retention pruning (see SQLite migration).
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_ts ON usage_snapshots(timestamp)`,
	);

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

	// Add UNIQUE index on (name, provider, COALESCE(custom_endpoint,'')) to
	// enforce atomic uniqueness for the account-add path (closes the same
	// race the SQLite path closes — see packages/database/src/migrations.ts).
	// PostgreSQL does not have an equivalent of SQLite's `CREATE UNIQUE
	// INDEX` that operates without a pre-existing index, so this migration
	// is the first place we install it. Behaviorally identical to the
	// SQLite dedup: collapse existing duplicates to one row per tuple while
	// preserving credential state and repointing dependent rows. Idempotent:
	// if the index already exists, the whole block is a no-op.
	const uniqueAccountsIndexExists = await adapter.get<{ exists: number }>(
		`SELECT COUNT(*) AS exists
		 FROM pg_indexes
		 WHERE schemaname = current_schema()
		   AND tablename = 'accounts'
		   AND indexname = 'idx_accounts_unique_name_provider_endpoint'`,
	);
	if ((uniqueAccountsIndexExists?.exists ?? 0) === 0) {
		await collapseAccountDuplicatesPreservingStatePg(adapter);
		await adapter.unsafe(
			`CREATE UNIQUE INDEX idx_accounts_unique_name_provider_endpoint
			 ON accounts (name, provider, COALESCE(custom_endpoint, ''))`,
		);
		log.info(
			"Created UNIQUE index idx_accounts_unique_name_provider_endpoint on accounts",
		);
	}

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
