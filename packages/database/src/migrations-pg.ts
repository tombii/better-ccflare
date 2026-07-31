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
			agent_attribution_source TEXT,
			stream_terminal_state TEXT,
			client_session_id TEXT
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

	// Create instance_heartbeats table: per-process heartbeat for the
	// multi-instance guard (see packages/database/src/multi-instance-guard.ts
	// and tombii/better-ccflare#351). Each instance writes one row and
	// refreshes `last_heartbeat` on a tick. Rows older than the expiry
	// window are treated as dead predecessors so a crash never blocks a
	// legitimate restart.
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS instance_heartbeats (
			instance_id TEXT PRIMARY KEY,
			hostname TEXT NOT NULL,
			pid INTEGER NOT NULL,
			started_at INTEGER NOT NULL,
			last_heartbeat INTEGER NOT NULL,
			node_version TEXT NOT NULL,
			db_dialect TEXT NOT NULL
		)
	`);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_instance_heartbeats_last_heartbeat ON instance_heartbeats(last_heartbeat)`,
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
/**
 * Duplicate-group scope for the survivor merge below. PostgreSQL permits a
 * numbered parameter to be referenced repeatedly, so the whole statement reuses
 * $5/$6/$7 for (name, provider, endpoint) rather than re-binding them per
 * column.
 */
const PG_GROUP_SCOPE = `WHERE name = $5 AND provider = $6
	                          AND COALESCE(custom_endpoint, '') = $7`;

/**
 * Freshest non-NULL value of `col` across the duplicate group, using the same
 * ordering that selects the credential set: newest refresh token first, then
 * newest row. `col` is an internal literal, never user input.
 */
function pgFreshest(col: string): string {
	return `(SELECT ${col} FROM accounts ${PG_GROUP_SCOPE} AND ${col} IS NOT NULL
		    ORDER BY COALESCE(refresh_token_issued_at, 0) DESC, created_at DESC
		    LIMIT 1)`;
}

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
			    LIMIT 1) AS merged_api_key,
			   -- Read from the SAME freshest row as the three token fields
			   -- above, using the identical ordering, so the survivor's
			   -- issued-at always describes the tokens it actually holds.
			   (SELECT refresh_token_issued_at FROM accounts
			    WHERE name = $1 AND provider = $2 AND COALESCE(custom_endpoint, '') = $3
			      AND refresh_token IS NOT NULL AND refresh_token <> ''
			    ORDER BY COALESCE(refresh_token_issued_at, 0) DESC, ctid::text ASC
			    LIMIT 1) AS merged_refresh_token_issued_at`,
			[grp.name, grp.provider, grp.ep],
		)) as Array<{
			merged_refresh_token: string | null;
			merged_access_token: string | null;
			merged_expires_at: string | null;
			merged_api_key: string | null;
			merged_refresh_token_issued_at: string | null;
		}>;
		const merged = mergedRows[0] ?? {
			merged_refresh_token: null,
			merged_access_token: null,
			merged_expires_at: null,
			merged_api_key: null,
			merged_refresh_token_issued_at: null,
		};

		// Merge aggregates into the survivor. Parameter slots $1..$4 carry
		// the credential pre-fills; $5..$34 are the per-aggregate (group
		// triple + max/min/sum) lookups (10 aggregates × 3 group keys);
		// $35 is the survivor id.
		await adapter.unsafe(
			// Must stay behaviourally identical to the SQLite merge in
			// migrations.ts — same column set, same rule per column. This is the
			// path that runs against PostgreSQL deployments, so a column merged
			// there and missed here loses real account state on upgrade.
			//
			//   MAX      — cooldown timestamps/counters (a collapse must never
			//              shorten a cooldown) and the 0/1 flag columns.
			//   MIN      — created_at (oldest birth), rate_limit_remaining (most
			//              conservative estimate of what is left).
			//   SUM      — lifetime/session counters, so history survives.
			//   COALESCE — survivor's own value, else the freshest non-NULL in
			//              the group (credentials and config columns).
			//
			// The flag columns are INTEGER, not BOOLEAN: 0 is a legitimate value,
			// not "unset". MAX is therefore the deliberate policy "enabled on any
			// duplicate wins", matching paused/requires_reauth.
			//
			// Not merged: id (survivor keeps its own; dependents are repointed),
			// and name/provider/custom_endpoint, which are the dedup key and are
			// identical across the group by construction.
			//
			// PostgreSQL allows a numbered parameter to be referenced more than
			// once, so the group key is just $5/$6/$7 throughout instead of the
			// 30 repeated bindings this previously carried — adding columns to a
			// positional list that long is how a binding silently shifts.
			`UPDATE accounts SET
			   refresh_token = $1,
			   access_token = $2,
			   expires_at = $3::BIGINT,
			   api_key = COALESCE(api_key, $4),
			   -- Must come from the SAME row as refresh_token/access_token/
			   -- expires_at above (all four are read from the single freshest
			   -- row), not recomputed as MAX across the group. Taking the group
			   -- MAX independently can pair row A's tokens with row B's newer
			   -- issued-at, so the stored "when were these tokens issued" no
			   -- longer describes the tokens actually held — which silently
			   -- misleads anything reasoning about token freshness. The SQLite
			   -- path already sources it from the merged row; this matches it.
			   refresh_token_issued_at = $9::BIGINT,
			   last_used = (SELECT MAX(COALESCE(last_used, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   created_at = (SELECT MIN(created_at) FROM accounts ${PG_GROUP_SCOPE}),
			   request_count = (SELECT SUM(COALESCE(request_count, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   total_requests = (SELECT SUM(COALESCE(total_requests, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   session_request_count = (SELECT SUM(COALESCE(session_request_count, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   priority = (SELECT MAX(COALESCE(priority, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   consecutive_rate_limits = (SELECT MAX(COALESCE(consecutive_rate_limits, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   paused = (SELECT MAX(COALESCE(paused, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   requires_reauth = (SELECT MAX(COALESCE(requires_reauth, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   rate_limited_until = (SELECT MAX(COALESCE(rate_limited_until, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   session_start = (SELECT MAX(COALESCE(session_start, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   rate_limit_reset = (SELECT MAX(COALESCE(rate_limit_reset, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   rate_limited_at = (SELECT MAX(COALESCE(rate_limited_at, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   auto_fallback_enabled = (SELECT MAX(COALESCE(auto_fallback_enabled, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   auto_refresh_enabled = (SELECT MAX(COALESCE(auto_refresh_enabled, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   auto_pause_on_overage_enabled = (SELECT MAX(COALESCE(auto_pause_on_overage_enabled, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   peak_hours_pause_enabled = (SELECT MAX(COALESCE(peak_hours_pause_enabled, 0)) FROM accounts ${PG_GROUP_SCOPE}),
			   rate_limit_remaining = (SELECT MIN(rate_limit_remaining) FROM accounts ${PG_GROUP_SCOPE} AND rate_limit_remaining IS NOT NULL),
			   rate_limit_status = COALESCE(rate_limit_status, ${pgFreshest("rate_limit_status")}),
			   pause_reason = COALESCE(pause_reason, ${pgFreshest("pause_reason")}),
			   rate_limited_reason = COALESCE(rate_limited_reason, ${pgFreshest("rate_limited_reason")}),
			   model_mappings = COALESCE(model_mappings, ${pgFreshest("model_mappings")}),
			   model_fallbacks = COALESCE(model_fallbacks, ${pgFreshest("model_fallbacks")}),
			   cross_region_mode = COALESCE(cross_region_mode, ${pgFreshest("cross_region_mode")}),
			   billing_type = COALESCE(billing_type, ${pgFreshest("billing_type")})
			 WHERE id = $8`,
			[
				merged.merged_refresh_token, // $1
				merged.merged_access_token, // $2
				merged.merged_expires_at, // $3
				merged.merged_api_key, // $4
				grp.name, // $5
				grp.provider, // $6
				grp.ep, // $7
				survivor.id, // $8
				merged.merged_refresh_token_issued_at, // $9
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

			const idPlaceholders = discardedIds.map((_, i) => `$${i + 1}`).join(",");
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
			table: "requests",
			column: "client_session_id",
			definition: "ALTER TABLE requests ADD COLUMN client_session_id TEXT",
		},
		{
			// Real SSE termination state for Anthropic-Messages-shaped
			// streaming responses — see packages/proxy/src/anthropic-terminal-recovery.ts
			// for the producer side. One of "complete" | "recovered" | "error"
			// | "truncated" | "client_cancelled" | NULL. NULL for non-streaming
			// responses or streams not wrapped by the terminal-recovery
			// observer. Production runs Postgres, so a sqlite-only migration
			// would silently no-op here — both backends must be updated.
			table: "requests",
			column: "stream_terminal_state",
			definition: "ALTER TABLE requests ADD COLUMN stream_terminal_state TEXT",
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

	// Performance indexes — mirrors packages/database/src/performance-indexes.ts
	// (addPerformanceIndexes) plus idx_api_keys_role, both applied to SQLite via
	// runMigrations() but previously missing here. CREATE INDEX IF NOT EXISTS is
	// idempotent, so it's safe to run on every startup.
	try {
		// Index on api_keys.role (mirrors migrations.ts ~line 1387)
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_api_keys_role ON api_keys(role)`,
		);

		// 1. Composite index on requests(timestamp, account_used) for time-based
		// account queries. Used in analytics for filtering by time range and account.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_timestamp_account
			 ON requests(timestamp DESC, account_used)`,
		);

		// 2. Index on requests(model, timestamp) for model analytics.
		// Used in model distribution and performance queries.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_model_timestamp
			 ON requests(model, timestamp DESC)
			 WHERE model IS NOT NULL`,
		);

		// 3. Index on requests(success, timestamp) for success rate calculations.
		// Used in analytics for calculating success rates over time.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_success_timestamp
			 ON requests(success, timestamp DESC)`,
		);

		// 4. Index on accounts(paused) for finding active accounts.
		// Used in load balancer to quickly filter active accounts.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_accounts_paused
			 ON accounts(paused)
			 WHERE paused = 0`,
		);

		// 5. Index on requests(account_used, timestamp) for per-account analytics.
		// Used in account performance queries.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_account_timestamp
			 ON requests(account_used, timestamp DESC)`,
		);

		// 6. Additional indexes based on observed query patterns

		// Index for cost analysis queries
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_cost_model
			 ON requests(cost_usd, model, timestamp DESC)
			 WHERE cost_usd > 0 AND model IS NOT NULL`,
		);

		// Index for response time analysis (for p95 calculations)
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_response_time
			 ON requests(model, response_time_ms)
			 WHERE response_time_ms IS NOT NULL AND model IS NOT NULL`,
		);

		// Index for token usage analysis
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_tokens
			 ON requests(timestamp DESC, total_tokens)
			 WHERE total_tokens > 0`,
		);

		// Index for account name lookups (used in analytics joins)
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_accounts_name
			 ON accounts(name)`,
		);

		// Index for rate limit checks
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_accounts_rate_limited
			 ON accounts(rate_limited_until)
			 WHERE rate_limited_until IS NOT NULL`,
		);

		// Index for session management
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_accounts_session
			 ON accounts(session_start, session_request_count)
			 WHERE session_start IS NOT NULL`,
		);

		// Composite index for account ordering in load balancer
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_accounts_request_count
			 ON accounts(request_count DESC, last_used)`,
		);

		// Index for account priority in load balancer
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_accounts_priority
			 ON accounts(priority ASC, request_count DESC, last_used)`,
		);

		// Index for OAuth session cleanup by account_name
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_account_name
			 ON oauth_sessions(account_name, expires_at)`,
		);

		// Index for API key filtering
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_api_key
			 ON requests(api_key_id)
			 WHERE api_key_id IS NOT NULL`,
		);

		// Composite index for API key analytics (filtering + time-based queries)
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_api_key_timestamp
			 ON requests(api_key_id, timestamp DESC)
			 WHERE api_key_id IS NOT NULL`,
		);

		// Composite index for project analytics (filtering + time-based queries)
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_project_timestamp
			 ON requests(project, timestamp DESC)
			 WHERE project IS NOT NULL`,
		);

		// 7. Covering index for DELETE cleanup operations.
		// Critical for performance of deleteOlderThan() which uses:
		//   DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE timestamp < ? LIMIT ?)
		// Without this covering index, the DB must hit the table to fetch id values
		// after finding rows by timestamp. With this covering index (timestamp ASC,
		// id), the entire subquery is satisfied from the index alone. ASC order
		// matches the "timestamp < cutoff" comparison used in cleanup queries.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_cleanup
			 ON requests(timestamp ASC, id)`,
		);

		// 8. Covering index for request_payloads cleanup.
		// Used by deletePayloadsOlderThan() which uses a similar pattern:
		//   DELETE FROM request_payloads WHERE id IN (SELECT id FROM request_payloads WHERE timestamp < ? LIMIT ?)
		// Note: timestamp may be NULL for legacy rows, so we use a partial index
		// where timestamp IS NOT NULL.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_request_payloads_cleanup
			 ON request_payloads(timestamp, id)
			 WHERE timestamp IS NOT NULL`,
		);

		// 9. Covering index for the Requests tab summary query.
		// Powers: SELECT r.*, a.name FROM requests r LEFT JOIN accounts a ON r.account_used = a.id
		//         ORDER BY r.timestamp DESC LIMIT ?
		// Including the most-queried scalar columns lets the DB satisfy the query
		// from the index without a heap lookup for every row.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_summary_covering
			 ON requests(timestamp DESC, id, account_used, status_code, success,
			             response_time_ms, model, total_tokens, cost_usd,
			             input_tokens, output_tokens, billing_type, combo_name,
			             failover_attempts)`,
		);

		// 10. Covering index for analytics aggregate queries (timestamp range scans).
		// Powers the analytics handler's WHERE timestamp > ? GROUP BY ts aggregate
		// queries. Includes aggregate columns so the DB can compute SUM/AVG/COUNT
		// without heap lookups. Column order: timestamp first (range filter), then
		// aggregate columns.
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_analytics_covering
			 ON requests(timestamp, success, total_tokens, cost_usd, billing_type,
			             output_tokens, input_tokens, cache_read_input_tokens,
			             cache_creation_input_tokens, output_tokens_per_second,
			             response_time_ms, account_used, model)`,
		);

		// 11. Index for billing_type time-range queries used in analytics cost breakdown
		await adapter.unsafe(
			`CREATE INDEX IF NOT EXISTS idx_requests_billing_type_timestamp
			 ON requests(billing_type, timestamp DESC)
			 WHERE billing_type IS NOT NULL`,
		);

		log.info("Performance indexes ensured");
	} catch (_error) {
		// Indexes may already exist
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
		// The existence check above is advisory only — it cannot be trusted as a
		// guard. Two server instances starting against the same database will
		// both observe "no index", and a row inserted between the collapse and
		// the CREATE would reintroduce a duplicate that makes the CREATE fail.
		//
		// Deliberately NOT solved with adapter.transaction() or a session
		// advisory lock:
		//   * adapter.transaction() does not currently give a PostgreSQL
		//     transaction. It calls `this.sql.begin(async () => fn())` and
		//     discards the reserved transaction connection `begin()` hands to
		//     the callback, so the statements inside `fn()` run on arbitrary
		//     POOL connections while an empty transaction opens and commits.
		//     Wrapping this block in it would look atomic and guarantee nothing.
		//   * `pg_advisory_lock` is session-scoped, and with a connection pool
		//     the lock and the statements it is supposed to protect can land on
		//     different connections.
		//
		// Instead the CREATE UNIQUE INDEX *is* the synchronisation primitive.
		// It is a single atomic statement that succeeds only when the table
		// genuinely holds no duplicates, so:
		//   * a concurrent insert that reintroduces a duplicate makes it fail,
		//     and we collapse and retry rather than proceeding on a false
		//     assumption;
		//   * two instances racing produce one winner; the loser sees the index
		//     already exists, which is success, not an error.
		// The collapse itself is idempotent (it is keyed on duplicate groups and
		// a no-op once none remain), so repeating it is safe.
		const MAX_ATTEMPTS = 3;
		let created = false;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS && !created; attempt++) {
			await collapseAccountDuplicatesPreservingStatePg(adapter);
			try {
				await adapter.unsafe(
					`CREATE UNIQUE INDEX idx_accounts_unique_name_provider_endpoint
					 ON accounts (name, provider, COALESCE(custom_endpoint, ''))`,
				);
				created = true;
			} catch (error) {
				// Another instance won the race and created it first: that is the
				// desired end state, not a failure.
				const stillMissing = await adapter.get<{ exists: number }>(
					`SELECT COUNT(*) AS exists
					 FROM pg_indexes
					 WHERE schemaname = current_schema()
					   AND tablename = 'accounts'
					   AND indexname = 'idx_accounts_unique_name_provider_endpoint'`,
				);
				if ((stillMissing?.exists ?? 0) > 0) {
					created = true;
					break;
				}
				// Otherwise a duplicate was inserted between the collapse and the
				// CREATE. Collapse again and retry; give up loudly rather than
				// leaving the uniqueness guarantee silently unenforced.
				if (attempt === MAX_ATTEMPTS) {
					log.error(
						`Failed to create UNIQUE index idx_accounts_unique_name_provider_endpoint after ${MAX_ATTEMPTS} attempts — account uniqueness is NOT enforced`,
					);
					throw error;
				}
				log.warn(
					`CREATE UNIQUE INDEX on accounts failed (attempt ${attempt}/${MAX_ATTEMPTS}), duplicates reappeared concurrently — collapsing and retrying`,
				);
			}
		}
		if (created) {
			log.info(
				"Created UNIQUE index idx_accounts_unique_name_provider_endpoint on accounts",
			);
		}
	}

	// Sanitize existing account names to prevent command injection. Mirrors
	// the SQLite migration in migrations.ts ("Sanitize existing account
	// names..."): replace any character outside [a-zA-Z0-9_-] with '_'.
	// Must run after the UNIQUE index above (matching migrations.ts
	// ordering, where the same index is created before this sanitization
	// block runs), since a sanitized name can collide with another account
	// under that composite (name, provider, COALESCE(custom_endpoint,''))
	// constraint. Ported as a JS-side loop (not a single regexp_replace
	// UPDATE) so the same incrementing-suffix collision avoidance as the
	// SQLite version applies: SQLite's loop guards against collisions by
	// checking `SELECT COUNT(*) FROM accounts WHERE name = ?` (name alone,
	// not the full tuple) — stricter than the actual constraint, but this
	// matches that exact behavior rather than diverging from it.
	try {
		const accountsForSanitize = await adapter.query<{
			id: string;
			name: string;
		}>(`SELECT id, name FROM accounts`);

		let sanitizedCount = 0;
		for (const account of accountsForSanitize) {
			if (!/^[a-zA-Z0-9\-_]+$/.test(account.name)) {
				const sanitizedName = account.name.replace(/[^a-zA-Z0-9\-_]/g, "_");

				let finalName = sanitizedName;
				let suffix = 1;
				let hasCollision = true;
				while (hasCollision) {
					const collidesInBatch = accountsForSanitize.some(
						(a) => a.id !== account.id && a.name === finalName,
					);
					const existing = await adapter.get<{ count: number }>(
						`SELECT COUNT(*) as count FROM accounts WHERE name = ?`,
						[finalName],
					);
					const collidesInDb = (existing?.count ?? 0) > 0;
					hasCollision = collidesInBatch || collidesInDb;
					if (hasCollision) {
						finalName = `${sanitizedName}_${suffix}`;
						suffix++;
					}
				}

				await adapter.run(`UPDATE accounts SET name = ? WHERE id = ?`, [
					finalName,
					account.id,
				]);
				sanitizedCount++;
				log.info(`Sanitized account name: "${account.name}" -> "${finalName}"`);
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

	// Run API key storage migration to move API keys from refresh_token to
	// api_key field. Mirrors runApiKeyStorageMigration() in migrations.ts.
	// Expressible as pure SQL (no JS-side iteration needed): matches the
	// exact provider list, NULL/empty handling, and console-account
	// detection heuristics of the SQLite version.
	try {
		// 1. Move API key from refresh_token to api_key for API-key providers,
		// only when api_key is unset and refresh_token actually holds a value.
		const updatedCount = await adapter.runWithChanges(
			`UPDATE accounts
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
			   AND LENGTH(refresh_token) > 0`,
		);

		// 2. Clean up duplicate storage where the same value is present in
		// both refresh_token and api_key.
		const cleanupCount = await adapter.runWithChanges(
			`UPDATE accounts
			 SET
			   refresh_token = NULL,
			   access_token = NULL,
			   expires_at = NULL
			 WHERE
			   provider IN ('zai', 'openai-compatible', 'minimax', 'anthropic-compatible')
			   AND api_key IS NOT NULL
			   AND refresh_token = api_key`,
		);

		// 3. Console accounts (provider 'anthropic') that stored their API key
		// in refresh_token instead of api_key. Excludes real Anthropic OAuth
		// refresh tokens (sk-ant-api03-*/sk-ant-*) and anything that looks
		// like a live OAuth session (has access_token, or expires_at within
		// the last 24h).
		const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;
		const consoleCount = await adapter.runWithChanges(
			`UPDATE accounts
			 SET
			   api_key = refresh_token,
			   refresh_token = NULL,
			   access_token = NULL,
			   expires_at = NULL
			 WHERE
			   provider = 'anthropic'
			   AND api_key IS NULL
			   AND refresh_token IS NOT NULL
			   AND refresh_token != ''
			   AND access_token IS NULL
			   AND (
			     expires_at IS NULL
			     OR expires_at = 0
			     OR expires_at < ?
			   )
			   AND refresh_token NOT LIKE 'sk-ant-api03-%'
			   AND refresh_token NOT LIKE 'sk-ant-%'`,
			[cutoffTime],
		);

		const totalCount = updatedCount + cleanupCount + consoleCount;
		if (totalCount > 0) {
			log.info(
				`Migrated ${totalCount} accounts to API key storage v2 (moved from refresh_token to api_key)`,
				{
					migrationVersion: 2,
					updatedAccounts: updatedCount,
					cleanupAccounts: cleanupCount,
					consoleAccounts: consoleCount,
				},
			);
		}
	} catch (error) {
		log.warn(
			`Error during API key storage migration: ${(error as Error).message}`,
		);
		// Continue with other migrations even if this one fails
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
