import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeConfig } from "@better-ccflare/config";
import type { Disposable } from "@better-ccflare/core";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import type {
	Account,
	AgentAttributionSource,
	Combo,
	ComboFamily,
	ComboFamilyAssignment,
	ComboSlot,
	ComboWithSlots,
	IntegrityStatus,
	ProjectAttributionSource,
	RateLimitReason,
	StrategyStore,
} from "@better-ccflare/types";
import {
	BunSqlAdapter,
	PG_CLIENT_QUERY_TIMEOUT_MS,
} from "./adapters/bun-sql-adapter";
import { EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE } from "./inline-incremental-vacuum-worker";
import { EMBEDDED_VACUUM_WORKER_CODE } from "./inline-vacuum-worker";
import { ensureSchema, runMigrations } from "./migrations";
import { ensureSchemaPg, runMigrationsPg } from "./migrations-pg";
import { resolveDbPath } from "./paths";
import { AccountRepository } from "./repositories/account.repository";
import { AgentPreferenceRepository } from "./repositories/agent-preference.repository";
import { ApiKeyRepository } from "./repositories/api-key.repository";
import { ComboRepository } from "./repositories/combo.repository";
import { OAuthRepository } from "./repositories/oauth.repository";
import {
	type RequestData,
	RequestRepository,
} from "./repositories/request.repository";
import { StatsRepository } from "./repositories/stats.repository";
import { StrategyRepository } from "./repositories/strategy.repository";
import { UsageHistoryRepository } from "./repositories/usage-history.repository";
import { withDatabaseRetry } from "./retry";

export interface DatabaseConfig {
	/** Enable WAL (Write-Ahead Logging) mode for better concurrency */
	walMode?: boolean;
	/** SQLite busy timeout in milliseconds */
	busyTimeoutMs?: number;
	/** Cache size in pages (negative value = KB) */
	cacheSize?: number;
	/** Synchronous mode: OFF, NORMAL, FULL */
	synchronous?: "OFF" | "NORMAL" | "FULL";
	/** Memory-mapped I/O size in bytes */
	mmapSize?: number;
	/** Retry configuration for database operations */
	retry?: DatabaseRetryConfig;
	/** Page size in bytes - default 2048 (2KB), recommend 4096 (4KB) for better memory efficiency */
	pageSize?: number;
}

export interface DatabaseRetryConfig {
	/** Maximum number of retry attempts for database operations */
	attempts?: number;
	/** Initial delay between retries in milliseconds */
	delayMs?: number;
	/** Backoff multiplier for exponential backoff */
	backoff?: number;
	/** Maximum delay between retries in milliseconds */
	maxDelayMs?: number;
}

/**
 * Apply SQLite pragmas for optimal performance on distributed filesystems.
 *
 * Note: `PRAGMA integrity_check` is NOT run here. The check is moved to a
 * background worker (see `packages/proxy/src/integrity-scheduler.ts`) so it
 * doesn't gate startup — on a multi-GB DB it can block the event loop for
 * tens of seconds. The scheduler runs `quick_check` every few hours and a
 * full `integrity_check` daily, surfacing corruption through `/api/storage`
 * and the dashboard "Storage Integrity" card.
 */
function configureSqlite(db: Database, config: DatabaseConfig): void {
	try {
		// MUST be the first write-affecting PRAGMA. SQLite's auto_vacuum
		// mode is locked in the DB header at first-write time. Anything that
		// causes pages to be allocated (notably `PRAGMA journal_mode = WAL`
		// below) BEFORE this call would leave a fresh DB stuck at
		// auto_vacuum=NONE. For DBs created prior to this change the PRAGMA
		// is a no-op (rejected on non-empty mode-0 DBs); the migration
		// happens via `bootstrapAutoVacuum()` at server startup.
		//
		// We ONLY issue the PRAGMA when the current mode is 0. SQLite quietly
		// allows mode 1 (FULL) → mode 2 (INCREMENTAL) transitions without a
		// VACUUM — issuing the PRAGMA unconditionally would silently rewrite
		// an operator's `auto_vacuum=FULL` choice, which is a behavior change
		// Greptile flagged on the original PR. (Greptile #230)
		const currentMode = (
			db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
		).auto_vacuum;
		if (currentMode === 0) {
			db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		}

		// Enable WAL mode for better concurrency (with error handling)
		if (config.walMode !== false) {
			try {
				const result = db.query("PRAGMA journal_mode = WAL").get() as {
					journal_mode: string;
				};
				if (result.journal_mode !== "wal") {
					console.warn(
						"Failed to enable WAL mode, falling back to DELETE mode",
					);
					db.run("PRAGMA journal_mode = DELETE");
				}
			} catch (error) {
				console.warn("WAL mode failed, using DELETE mode:", error);
				db.run("PRAGMA journal_mode = DELETE");
			}
		}

		// Set busy timeout for lock handling
		if (config.busyTimeoutMs !== undefined) {
			db.run(`PRAGMA busy_timeout = ${config.busyTimeoutMs}`);
		}

		// Configure cache size
		if (config.cacheSize !== undefined) {
			db.run(`PRAGMA cache_size = ${config.cacheSize}`);
		}

		// Set synchronous mode (more conservative for distributed filesystems)
		const syncMode = config.synchronous || "FULL"; // Default to FULL for safety
		db.run(`PRAGMA synchronous = ${syncMode}`);

		// Configure memory-mapped I/O. `mmap_size = 0` is the SQLite-defined
		// way to *disable* mmap, so the value 0 is a meaningful setting — not
		// "no preference". Previously this branch was gated on `> 0`, which
		// meant the default `mmapSize: 0` silently fell through and bun:sqlite
		// used its built-in default (~15 GiB observed on a 15 GiB DB). That
		// memory-maps the entire file, which is invisible until something
		// walks every page — e.g. a full-DB VACUUM — at which point the
		// resident set explodes and the cgroup OOM-kills the process. Treat
		// `mmapSize` as "issue the PRAGMA whenever the operator has specified
		// a value, including 0".
		if (config.mmapSize !== undefined) {
			try {
				db.run(`PRAGMA mmap_size = ${config.mmapSize}`);
			} catch (error) {
				console.warn("Failed to set mmap_size:", error);
			}
		}

		// Set page size (only effective before any data is written, or after VACUUM)
		if (config.pageSize !== undefined) {
			const currentPageSize = (
				db.query("PRAGMA page_size").get() as { page_size: number }
			).page_size;
			if (currentPageSize !== config.pageSize) {
				db.run(`PRAGMA page_size = ${config.pageSize}`);
			}
		}

		// Additional optimizations for distributed filesystems
		db.run("PRAGMA temp_store = MEMORY");
		db.run("PRAGMA foreign_keys = ON");

		// Add checkpoint interval for WAL mode (1000 pages = ~4MB with 4KB pages)
		// Higher threshold reduces checkpoint frequency for better throughput under high traffic
		db.run("PRAGMA wal_autocheckpoint = 1000");
	} catch (error) {
		console.error("Database configuration failed:", error);
		throw new Error(`Failed to configure SQLite database: ${error}`);
	}
}

/**
 * After this many consecutive `incrementalVacuum()` ticks fail to claim
 * the writer slot, the per-tick console.warn escalates to a louder
 * "sustained-busy" line. 3 ticks = 3 hours of missed reclamation, which
 * is the threshold where free pages start growing noticeably on a
 * write-heavy DB. (Greptile #230)
 */
const INC_VAC_SKIP_ESCALATE_AT = 3;

/**
 * DatabaseOperations using Repository Pattern
 * Provides a clean, organized interface for database operations
 *
 * Supports both SQLite (default) and PostgreSQL (via DATABASE_URL env var).
 * All public methods are async to support both backends.
 */
export class DatabaseOperations implements StrategyStore, Disposable {
	private adapter: BunSqlAdapter;
	/** Raw bun:sqlite Database — only set in SQLite mode */
	private sqliteDb?: Database;
	/** Resolved path to the SQLite DB file — used by the vacuum worker */
	private resolvedDbPath?: string;
	/**
	 * auto_vacuum mode as it was on disk when this handle was opened, captured
	 * BEFORE `configureSqlite()` issues its own `PRAGMA auto_vacuum =
	 * INCREMENTAL`. SQLite quirk: that PRAGMA flips the connection-local view
	 * to the requested value even though the on-disk header can't change
	 * without a VACUUM — so a later `PRAGMA auto_vacuum` query on this
	 * connection returns the requested value, not the persisted one. Used by
	 * `bootstrapAutoVacuum()` to decide whether a migration VACUUM is actually
	 * needed. (Greptile #230)
	 */
	private originalAutoVacuumMode?: number;
	/** Prevents concurrent compact() calls from spawning multiple vacuum workers */
	private compacting = false;
	/**
	 * Hourly `incrementalVacuum()` ticks that bailed because the worker
	 * couldn't claim the writer slot (SQLITE_BUSY). Bumped on every failure,
	 * reset on every success. Once it crosses `INC_VAC_SKIP_ESCALATE_AT` we
	 * upgrade the per-tick `console.warn` to a louder warning so an operator
	 * notices the DB isn't reclaiming pages — without that, sustained write
	 * activity at tick time could leave free pages unreclaimed indefinitely.
	 * (Greptile #230)
	 */
	private incVacuumConsecutiveSkips = 0;
	private runtime?: RuntimeConfig;
	private dbConfig: DatabaseConfig;
	private retryConfig: DatabaseRetryConfig;
	readonly isSQLite: boolean;
	/** Cached integrity check status; surfaced via /api/storage and /health. */
	private integrityStatus: IntegrityStatus = {
		status: "unchecked",
		runningKind: null,
		lastCheckAt: null,
		lastError: null,
		lastQuickCheckAt: null,
		lastQuickResult: null,
		lastQuickError: null,
		lastFullCheckAt: null,
		lastFullResult: null,
		lastFullError: null,
		lastQuickSkipReason: null,
		lastFullSkipReason: null,
	};

	// Repositories
	private accounts: AccountRepository;
	private requests: RequestRepository;
	private oauth: OAuthRepository;
	private strategy: StrategyRepository;
	private stats: StatsRepository;
	private agentPreferences: AgentPreferenceRepository;
	private apiKeys: ApiKeyRepository;
	private combo: ComboRepository;
	private usageHistory: UsageHistoryRepository;

	constructor(
		dbPath?: string,
		dbConfig?: DatabaseConfig,
		retryConfig?: DatabaseRetryConfig,
	) {
		// Default database configuration optimized for distributed filesystems
		this.dbConfig = {
			walMode: true,
			busyTimeoutMs: 10000,
			cacheSize: -5000,
			synchronous: "FULL",
			mmapSize: 0,
			pageSize: 2048,
			...dbConfig,
		};

		// Default retry configuration for database operations
		this.retryConfig = {
			attempts: 3,
			delayMs: 100,
			backoff: 2,
			maxDelayMs: 5000,
			...retryConfig,
		};

		// Detect PostgreSQL mode from DATABASE_URL
		const databaseUrl = process.env.DATABASE_URL;
		const isPostgres =
			databaseUrl &&
			(databaseUrl.startsWith("postgres://") ||
				databaseUrl.startsWith("postgresql://"));

		if (isPostgres) {
			this.isSQLite = false;
			// Import SQL lazily to avoid issues when not needed
			const { SQL } = require("bun");
			const pgMax = Number(process.env.BETTER_CCFLARE_DB_POOL_MAX ?? 10);
			const pgIdleTimeout = Number(
				process.env.BETTER_CCFLARE_DB_IDLE_TIMEOUT ?? 0,
			);
			// Server-side timeout must stay below the adapter's client-side race
			// (PG_CLIENT_QUERY_TIMEOUT_MS) so PG cancels the statement — freeing
			// its pool connection — before the client gives up. A non-numeric,
			// zero/negative (PG treats 0 as "disabled"), or too-large override is
			// silently clamped rather than trusted, since an unbounded value here
			// reopens the exact connection-leak bug this timeout exists to close.
			const requestedPgStatementTimeout = Number(
				process.env.BETTER_CCFLARE_DB_STATEMENT_TIMEOUT,
			);
			const maxPgStatementTimeout = PG_CLIENT_QUERY_TIMEOUT_MS - 1000;
			const pgStatementTimeout =
				Number.isFinite(requestedPgStatementTimeout) &&
				requestedPgStatementTimeout > 0 &&
				requestedPgStatementTimeout <= maxPgStatementTimeout
					? requestedPgStatementTimeout
					: maxPgStatementTimeout;
			// Named prepared statements are disabled by default: Bun's native PG
			// driver has a known class of bugs (oven-sh/bun#16774) where concurrent
			// queries sharing a pooled connection can misattribute a cached
			// statement's column metadata, corrupting binary integer decoding
			// (ERR_POSTGRES_UNSUPPORTED_INTEGER_SIZE — #284). Unnamed prepared
			// statements close this window since they don't persist across queries.
			const pgPrepare = process.env.BETTER_CCFLARE_DB_PG_PREPARE === "true";
			const sqlClient = new SQL({
				url: databaseUrl,
				max: pgMax,
				idleTimeout: pgIdleTimeout,
				prepare: pgPrepare,
				connection: {
					// Server-side timeout so PG cancels the query and frees the
					// connection instead of leaving it occupied after the client
					// gives up. Matches the client-side Promise.race in BunSqlAdapter.
					statement_timeout: pgStatementTimeout,
				},
			});
			// ERR_POSTGRES_IDLE_TIMEOUT is a normal pool lifecycle event (idle
			// connection reaped). Without this handler it bubbles as an unhandled
			// error and crashes the process, causing 502s behind a load balancer.
			sqlClient.on?.("error", (err: Error & { code?: string }) => {
				if (err?.code === "ERR_POSTGRES_IDLE_TIMEOUT") return;
				console.error("[postgres] pool error:", err);
			});
			this.adapter = new BunSqlAdapter(sqlClient, false);
		} else {
			this.isSQLite = true;
			const resolvedPath = dbPath ?? resolveDbPath();
			this.resolvedDbPath = resolvedPath;

			// Ensure the directory exists
			const dir = dirname(resolvedPath);
			mkdirSync(dir, { recursive: true });

			this.sqliteDb = new Database(resolvedPath, { create: true });

			// Capture the persisted auto_vacuum mode BEFORE configureSqlite's
			// leading PRAGMA flips the connection-local view. See the field
			// docstring for the SQLite quirk this works around. (Greptile #230)
			this.originalAutoVacuumMode = (
				this.sqliteDb.query("PRAGMA auto_vacuum").get() as {
					auto_vacuum: number;
				}
			).auto_vacuum;

			// Apply SQLite configuration
			configureSqlite(this.sqliteDb, this.dbConfig);

			ensureSchema(this.sqliteDb);
			runMigrations(this.sqliteDb, resolvedPath);

			this.adapter = new BunSqlAdapter(this.sqliteDb);
		}

		// Initialize repositories
		this.accounts = new AccountRepository(this.adapter);
		this.requests = new RequestRepository(this.adapter);
		this.oauth = new OAuthRepository(this.adapter);
		this.strategy = new StrategyRepository(this.adapter);
		this.stats = new StatsRepository(this.adapter);
		this.agentPreferences = new AgentPreferenceRepository(this.adapter);
		this.apiKeys = new ApiKeyRepository(this.adapter);
		this.combo = new ComboRepository(this.adapter);
		this.usageHistory = new UsageHistoryRepository(this.adapter);
	}

	/**
	 * Initialize the PostgreSQL schema (async, must be called after construction in PG mode)
	 */
	async initializeAsync(): Promise<void> {
		if (!this.isSQLite) {
			await ensureSchemaPg(this.adapter);
			await runMigrationsPg(this.adapter);
		}
	}

	setRuntimeConfig(runtime: RuntimeConfig): void {
		this.runtime = runtime;

		// Update retry config from runtime config if available
		if (runtime.database?.retry) {
			this.retryConfig = {
				...this.retryConfig,
				...runtime.database.retry,
			};
		}
	}

	/**
	 * Get the underlying BunSqlAdapter for direct queries.
	 * Use this instead of getDatabase() for cross-backend compatible raw queries.
	 */
	getAdapter(): BunSqlAdapter {
		return this.adapter;
	}

	/**
	 * Get the underlying bun:sqlite Database.
	 * @deprecated Use getAdapter() for cross-backend compatible code.
	 * Only valid when running in SQLite mode.
	 */
	getDatabase(): Database {
		if (!this.sqliteDb) {
			throw new Error(
				"getDatabase() is not available in PostgreSQL mode. Use getAdapter() instead.",
			);
		}
		return this.sqliteDb;
	}

	async runQuickIntegrityCheck(): Promise<string> {
		if (!this.sqliteDb) {
			// PostgreSQL: verify connectivity with a lightweight query
			await this.adapter.get("SELECT 1 AS ok");
			return "ok";
		}
		const result = this.sqliteDb.query("PRAGMA quick_check").get() as {
			quick_check: string;
		};
		return result.quick_check;
	}

	/**
	 * Run the full integrity check. Combines `PRAGMA integrity_check` and
	 * `PRAGMA foreign_key_check`: per SQLite docs `integrity_check` does NOT
	 * verify foreign keys, so detecting "silent wrong results" needs both.
	 *
	 * Returns "ok" when both pragmas pass; otherwise a multi-line error
	 * description combining the failing reports.
	 *
	 * NOTE: blocking. On a multi-GB DB this can take tens of seconds. Callers
	 * on the proxy hot path must invoke this via the integrity-check worker
	 * to avoid freezing the event loop.
	 */
	async runFullIntegrityCheck(): Promise<string> {
		if (!this.sqliteDb) {
			// PostgreSQL: verify connectivity with a lightweight query
			await this.adapter.get("SELECT 1 AS ok");
			return "ok";
		}
		// integrity_check can return multiple rows for long error reports.
		const integrityRows = this.sqliteDb
			.query("PRAGMA integrity_check")
			.all() as Array<{ integrity_check: string }>;
		const integrityMsg = integrityRows.map((r) => r.integrity_check).join("\n");

		// foreign_key_check returns one row per violation (empty result = ok).
		const fkRows = this.sqliteDb
			.query("PRAGMA foreign_key_check")
			.all() as Array<Record<string, unknown>>;
		const integrityOk = integrityMsg === "ok";
		const fkOk = fkRows.length === 0;
		if (integrityOk && fkOk) return "ok";

		const parts: string[] = [];
		if (!integrityOk) parts.push(`integrity_check: ${integrityMsg}`);
		if (!fkOk) {
			parts.push(
				`foreign_key_check: ${fkRows.length} violation(s) — ${JSON.stringify(fkRows.slice(0, 5))}${fkRows.length > 5 ? " (truncated)" : ""}`,
			);
		}
		return parts.join("\n");
	}

	/**
	 * Get cached integrity status (copy — caller can't mutate internal state).
	 */
	getIntegrityStatus(): IntegrityStatus {
		return { ...this.integrityStatus };
	}

	/**
	 * Path to the live SQLite file, or `undefined` when running against
	 * PostgreSQL or before initialization. Used by the integrity-check worker
	 * to open its own read-only handle.
	 */
	getResolvedDbPath(): string | undefined {
		return this.resolvedDbPath;
	}

	/**
	 * Mark an integrity probe as in flight. Callers must pair this with
	 * `recordIntegrityResult()`. Returns false if a probe is already running
	 * — used as a cheap mutex.
	 */
	markIntegrityCheckRunning(kind: "quick" | "full"): boolean {
		if (this.integrityStatus.status === "running") return false;
		this.integrityStatus = {
			...this.integrityStatus,
			status: "running",
			runningKind: kind,
		};
		return true;
	}

	/**
	 * Record the outcome of a quick or full integrity probe and recompute the
	 * collapsed `status` field.
	 *
	 * Sticky-corrupt rule:
	 *  - A full `corrupt` result poisons `status` until another *full* probe
	 *    returns `ok`. A subsequent quick `ok` does NOT clear it. Without
	 *    this, the 6-hourly quick_check would mask the daily full check's
	 *    silent-corruption findings (index/table mismatch, FK violations).
	 *  - A quick `corrupt` is also reflected immediately, and is cleared by
	 *    the next quick `ok` (or a full `ok` if the full result was also
	 *    quick-detectable, which any structural corruption is).
	 */
	recordIntegrityResult(
		kind: "quick" | "full",
		result: "ok" | "corrupt",
		error?: string | null,
	): void {
		const now = Date.now();
		const next: IntegrityStatus = {
			...this.integrityStatus,
			runningKind: null,
		};

		if (kind === "quick") {
			next.lastQuickCheckAt = now;
			next.lastQuickResult = result;
			next.lastQuickError = result === "corrupt" ? (error ?? null) : null;
			// A completed quick probe supersedes any prior quick skip note.
			next.lastQuickSkipReason = null;
		} else {
			next.lastFullCheckAt = now;
			next.lastFullResult = result;
			next.lastFullError = result === "corrupt" ? (error ?? null) : null;
			// A completed full probe supersedes any prior full skip note.
			next.lastFullSkipReason = null;
			// A passing full check is a strict superset of quick_check, so it
			// subsumes any lingering quick-corrupt: if the structurally-more-
			// thorough probe is clean, the structurally-less-thorough probe's
			// stale corrupt verdict is no longer accurate. Without this clear,
			// a quick `corrupt` recorded six hours ago would keep collapsed
			// `status = "corrupt"` on the dashboard until the next quick tick
			// even though a full check just returned ok.
			if (result === "ok") {
				next.lastQuickResult = "ok";
				next.lastQuickError = null;
			}
		}

		next.lastCheckAt = now;

		// Recompute collapsed status. Order: any corrupt result wins.
		const fullCorrupt = next.lastFullResult === "corrupt";
		const quickCorrupt = next.lastQuickResult === "corrupt";
		if (fullCorrupt || quickCorrupt) {
			next.status = "corrupt";
			next.lastError =
				next.lastFullError ?? next.lastQuickError ?? "integrity check failed";
		} else if (next.lastQuickResult === "ok" || next.lastFullResult === "ok") {
			next.status = "ok";
			next.lastError = null;
		} else {
			next.status = "unchecked";
			next.lastError = null;
		}

		this.integrityStatus = next;
	}

	/**
	 * Record that an integrity probe was attempted but skipped — either the DB
	 * is over the configured size threshold (so the full check would exceed the
	 * worker timeout) or the worker run itself timed out. A skip is purely
	 * informational: it preserves the last real ok/corrupt verdict and never
	 * moves the collapsed `status` to "corrupt" (a timeout is not corruption).
	 *
	 * Releases the mutex just like `recordIntegrityResult` so the next tick is
	 * eligible to run.
	 */
	recordIntegritySkipped(kind: "quick" | "full", reason: string): void {
		const now = Date.now();
		const next: IntegrityStatus = {
			...this.integrityStatus,
			runningKind: null,
		};

		next.lastCheckAt = now;

		if (kind === "quick") {
			next.lastQuickCheckAt = now;
			next.lastQuickSkipReason = reason;
			// Leave lastQuickResult/lastQuickError unchanged — preserve the last
			// real verdict.
		} else {
			next.lastFullCheckAt = now;
			next.lastFullSkipReason = reason;
			// Leave lastFullResult/lastFullError unchanged — preserve the last
			// real verdict.
		}

		// Recompute collapsed status with the SAME logic as
		// recordIntegrityResult. A skip must never set status to "corrupt".
		const fullCorrupt = next.lastFullResult === "corrupt";
		const quickCorrupt = next.lastQuickResult === "corrupt";
		if (fullCorrupt || quickCorrupt) {
			next.status = "corrupt";
			next.lastError =
				next.lastFullError ?? next.lastQuickError ?? "integrity check failed";
		} else if (next.lastQuickResult === "ok" || next.lastFullResult === "ok") {
			next.status = "ok";
			next.lastError = null;
		} else {
			next.status = "unchecked";
			next.lastError = null;
		}

		this.integrityStatus = next;
	}

	/**
	 * Get storage metrics for database health monitoring
	 */
	async getStorageMetrics(): Promise<{
		dbBytes: number;
		walBytes: number;
		orphanPages: number;
		lastRetentionSweepAt: number | null;
		nullAccountRows: number;
	}> {
		// Database file size
		const dbBytes = await this.getDbSizeBytes();

		// WAL file size (if exists)
		let walBytes = 0;
		if (this.resolvedDbPath) {
			const walPath = `${this.resolvedDbPath}-wal`;
			try {
				const { size } = await stat(walPath);
				walBytes = size;
			} catch {
				// WAL file doesn't exist or can't be accessed
			}
		}

		// Orphan pages (freelist count) - only in SQLite mode
		let orphanPages = 0;
		if (this.sqliteDb) {
			const result = this.sqliteDb.query("PRAGMA freelist_count").get() as {
				freelist_count: number;
			};
			orphanPages = result.freelist_count;
		}

		// Last retention sweep timestamp
		let lastRetentionSweepAt: number | null = null;
		try {
			const strategy = await this.getStrategy("data-retention");
			if (strategy?.config?.lastSweepAt) {
				lastRetentionSweepAt = strategy.config.lastSweepAt as number;
			}
		} catch {
			// strategies table may not exist in SQLite mode
		}

		// Null account rows (requests with account_used IS NULL in last 24h)
		const cutoff = Date.now() - TIME_CONSTANTS.DAY;
		const nullAccountRow = await this.adapter.get<{ count: number }>(
			"SELECT COUNT(*) AS count FROM requests WHERE account_used IS NULL AND timestamp >= ?",
			[cutoff],
		);
		const nullAccountRows = nullAccountRow?.count ?? 0;

		return {
			dbBytes,
			walBytes,
			orphanPages,
			lastRetentionSweepAt,
			nullAccountRows,
		};
	}

	/**
	 * Generate manual recovery instructions for corrupted database
	 */
	generateRecoveryInstructions(): string {
		const dbPath =
			this.resolvedDbPath ?? "~/.config/better-ccflare/better-ccflare.db";
		return `
DATABASE RECOVERY INSTRUCTIONS

If your database is corrupted, follow these steps:

1. STOP THE SERVER
   bun run cli --stop

2. BACKUP CORRUPTED DATABASE
   cp ${dbPath} ${dbPath}.corrupted.backup
   cp ${dbPath}-wal ${dbPath}-wal.corrupted.backup 2>/dev/null || true
   cp ${dbPath}-shm ${dbPath}-shm.corrupted.backup 2>/dev/null || true

3. ATTEMPT RECOVERY (optional)
   sqlite3 ${dbPath}.corrupted.backup ".recover" > recovered.sql
   sqlite3 ${dbPath}.new < recovered.sql
   # If successful, replace original:
   mv ${dbPath}.new ${dbPath}

4. START FRESH (if recovery fails)
   rm ${dbPath} ${dbPath}-wal ${dbPath}-shm
   # Restart server - it will create a new empty database
   bun start

5. RE-ADD ACCOUNTS
   bun run cli --add-account <name> --mode <mode> --priority <number>

NOTE: You will lose all historical request data and account configurations.
OAuth tokens will need to be re-authenticated.
`.trim();
	}

	/**
	 * Get the current retry configuration
	 */
	getRetryConfig(): DatabaseRetryConfig {
		return this.retryConfig;
	}

	// Account operations delegated to repository with retry logic
	async getAllAccounts(): Promise<Account[]> {
		return withDatabaseRetry(
			() => this.accounts.findAll(),
			this.retryConfig,
			"getAllAccounts",
		);
	}

	async getAccount(accountId: string): Promise<Account | null> {
		return withDatabaseRetry(
			() => this.accounts.findById(accountId),
			this.retryConfig,
			"getAccount",
		);
	}

	async updateAccountTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	): Promise<void> {
		await withDatabaseRetry(
			() =>
				this.accounts.updateTokens(
					accountId,
					accessToken,
					expiresAt,
					refreshToken,
				),
			this.retryConfig,
			"updateAccountTokens",
		);
	}

	async updateAccountUsage(accountId: string): Promise<void> {
		const sessionDuration =
			this.runtime?.sessionDurationMs || 5 * 60 * 60 * 1000;
		await withDatabaseRetry(
			() => this.accounts.incrementUsage(accountId, sessionDuration),
			this.retryConfig,
			"updateAccountUsage",
		);
	}

	async markAccountRateLimited(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<number> {
		return withDatabaseRetry(
			() => this.accounts.markAccountRateLimited(accountId, until, reason),
			this.retryConfig,
			"markAccountRateLimited",
		);
	}

	async resetConsecutiveRateLimits(accountId: string): Promise<void> {
		await withDatabaseRetry(
			() => this.accounts.resetConsecutiveRateLimits(accountId),
			this.retryConfig,
			"resetConsecutiveRateLimits",
		);
	}

	/**
	 * Clear expired rate_limited_until values from all accounts
	 * @param now The current timestamp to compare against
	 * @returns Number of accounts that had their rate_limited_until cleared
	 */
	async clearExpiredRateLimits(now: number): Promise<number> {
		return withDatabaseRetry(
			() => this.accounts.clearExpiredRateLimits(now),
			this.retryConfig,
			"clearExpiredRateLimits",
		);
	}

	async updateAccountRateLimitMeta(
		accountId: string,
		status: string,
		reset: number | null,
		remaining?: number | null,
	): Promise<void> {
		await this.accounts.updateRateLimitMeta(
			accountId,
			status,
			reset,
			remaining,
		);
	}

	// Usage-history operations delegated to repository
	getUsageHistoryRepository(): UsageHistoryRepository {
		return this.usageHistory;
	}

	async recordUsageSnapshot(
		accountId: string,
		usage: Record<string, unknown>,
		now: number,
	): Promise<void> {
		await this.usageHistory.recordSnapshot(accountId, usage, now);
	}

	async getUsageHistory(opts: {
		accountId: string;
		windowKey?: string;
		since?: number;
		until?: number;
	}) {
		return this.usageHistory.getSeries(opts);
	}

	async pruneUsageSnapshots(cutoffTs: number): Promise<number> {
		return this.usageHistory.deleteOlderThan(cutoffTs);
	}

	async forceResetAccountRateLimit(accountId: string): Promise<boolean> {
		return withDatabaseRetry(
			async () => {
				const changes = await this.accounts.clearRateLimitState(accountId);
				return changes >= 0;
			},
			this.retryConfig,
			"forceResetAccountRateLimit",
		);
	}

	async pauseAccount(accountId: string, reason = "manual"): Promise<void> {
		await this.accounts.pause(accountId, reason);
	}

	async resumeAccount(accountId: string): Promise<void> {
		await this.accounts.resume(accountId);
	}

	async renameAccount(accountId: string, newName: string): Promise<void> {
		await this.accounts.rename(accountId, newName);
	}

	async resetAccountSession(
		accountId: string,
		timestamp: number,
	): Promise<void> {
		await this.accounts.resetSession(accountId, timestamp);
	}

	async setAccountBillingType(
		accountId: string,
		billingType: string | null,
	): Promise<void> {
		await this.accounts.setBillingType(accountId, billingType);
	}

	async updateAccountRequestCount(
		accountId: string,
		count: number,
	): Promise<void> {
		await this.accounts.updateRequestCount(accountId, count);
	}

	async updateAccountPriority(
		accountId: string,
		priority: number,
	): Promise<void> {
		await this.accounts.updatePriority(accountId, priority);
	}

	async setAutoFallbackEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.accounts.setAutoFallbackEnabled(accountId, enabled);
	}

	async setAutoPauseOnOverageEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.accounts.setAutoPauseOnOverageEnabled(accountId, enabled);
	}

	async setPeakHoursPauseEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.adapter.run(
			"UPDATE accounts SET peak_hours_pause_enabled = ? WHERE id = ?",
			[enabled ? 1 : 0, accountId],
		);
	}

	async hasAccountsForProvider(provider: string): Promise<boolean> {
		return this.accounts.hasAccountsForProvider(provider);
	}

	// Request operations delegated to repository

	async saveRequest(
		id: string,
		method: string,
		path: string,
		accountUsed: string | null,
		statusCode: number | null,
		success: boolean,
		errorMessage: string | null,
		responseTime: number,
		failoverAttempts: number,
		usage?: RequestData["usage"],
		agentUsed?: string,
		apiKeyId?: string,
		apiKeyName?: string,
		project?: string | null,
		billingType?: string,
		comboName?: string | null,
		originalModel?: string | null,
		appliedModel?: string | null,
		projectAttributionSource?: ProjectAttributionSource | null,
		agentAttributionSource?: AgentAttributionSource | null,
	): Promise<void> {
		await withDatabaseRetry(
			() =>
				this.requests.save({
					id,
					method,
					path,
					accountUsed,
					statusCode,
					success,
					errorMessage,
					responseTime,
					failoverAttempts,
					usage,
					agentUsed,
					apiKeyId,
					apiKeyName,
					project,
					billingType,
					comboName,
					originalModel,
					appliedModel,
					projectAttributionSource,
					agentAttributionSource,
				}),
			this.retryConfig,
			"saveRequest",
		);
	}

	async updateRequestUsage(
		requestId: string,
		usage: RequestData["usage"],
	): Promise<void> {
		await withDatabaseRetry(
			() => this.requests.updateUsage(requestId, usage),
			this.retryConfig,
			"updateRequestUsage",
		);
	}

	async saveRequestPayload(id: string, data: unknown): Promise<void> {
		await withDatabaseRetry(
			() => this.requests.savePayload(id, data),
			this.retryConfig,
			"saveRequestPayload",
		);
	}

	async saveRequestPayloadRaw(id: string, json: string): Promise<void> {
		await withDatabaseRetry(
			() => this.requests.savePayloadRaw(id, json),
			this.retryConfig,
			"saveRequestPayloadRaw",
		);
	}

	async getRequestPayload(id: string): Promise<unknown | null> {
		return this.requests.getPayload(id);
	}

	async listRequestPayloads(
		limit = 50,
	): Promise<Array<{ id: string; json: string }>> {
		return this.requests.listPayloads(limit);
	}

	async listRequestPayloadsWithAccountNames(limit = 50): Promise<
		Array<{
			id: string;
			json: string | null;
			timestamp: number;
			account_name: string | null;
		}>
	> {
		return this.requests.listPayloadsWithAccountNames(limit);
	}

	// OAuth operations delegated to repository
	async createOAuthSession(
		sessionId: string,
		accountName: string,
		verifier: string,
		mode: "console" | "claude-oauth",
		customEndpoint?: string,
		priority: number = 0,
		ttlMinutes = 10,
	): Promise<void> {
		await this.oauth.createSession(
			sessionId,
			accountName,
			verifier,
			mode,
			customEndpoint,
			priority,
			ttlMinutes,
		);
	}

	async getOAuthSession(sessionId: string): Promise<{
		accountName: string;
		verifier: string;
		mode: "console" | "claude-oauth";
		customEndpoint?: string;
		priority: number;
	} | null> {
		return this.oauth.getSession(sessionId);
	}

	async deleteOAuthSession(sessionId: string): Promise<void> {
		await this.oauth.deleteSession(sessionId);
	}

	async cleanupExpiredOAuthSessions(): Promise<number> {
		return this.oauth.cleanupExpiredSessions();
	}

	// Strategy operations delegated to repository
	async getStrategy(name: string): Promise<{
		name: string;
		config: Record<string, unknown>;
		updatedAt: number;
	} | null> {
		return this.strategy.getStrategy(name);
	}

	async setStrategy(
		name: string,
		config: Record<string, unknown>,
	): Promise<void> {
		await this.strategy.set(name, config);
	}

	async listStrategies(): Promise<
		Array<{
			name: string;
			config: Record<string, unknown>;
			updatedAt: number;
		}>
	> {
		return this.strategy.list();
	}

	async deleteStrategy(name: string): Promise<boolean> {
		return this.strategy.delete(name);
	}

	// Analytics methods delegated to request repository
	async getRecentRequests(limit = 100): Promise<
		Array<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			status_code: number | null;
			success: boolean;
			response_time_ms: number | null;
		}>
	> {
		return this.requests.getRecentRequests(limit);
	}

	async getRequestStats(since?: number): Promise<{
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		avgResponseTime: number | null;
	}> {
		return this.requests.getRequestStats(since);
	}

	async aggregateStats(rangeMs?: number) {
		return this.requests.aggregateStats(rangeMs);
	}

	async getRecentErrors(limit?: number): Promise<string[]> {
		return this.requests.getRecentErrors(limit);
	}

	async getTopModels(
		limit?: number,
	): Promise<Array<{ model: string; count: number }>> {
		return this.requests.getTopModels(limit);
	}

	async getRequestsByAccount(since?: number): Promise<
		Array<{
			accountId: string;
			accountName: string | null;
			requestCount: number;
			successRate: number;
		}>
	> {
		return this.requests.getRequestsByAccount(since);
	}

	// Cleanup operations — two explicit passes:
	// Pass 1: delete payloads older than payloadRetentionMs (+ orphan sweep)
	// Pass 2: delete request metadata older than requestRetentionMs
	async cleanupOldRequests(
		payloadRetentionMs: number,
		requestRetentionMs?: number,
	): Promise<{
		removedRequests: number;
		removedPayloads: number;
	}> {
		const now = Date.now();

		// Pass 1 — payloads
		const payloadCutoff = now - payloadRetentionMs;
		const removedPayloadsByAge =
			await this.requests.deletePayloadsOlderThan(payloadCutoff);
		const removedOrphans = await this.requests.deleteOrphanedPayloads();

		// Pass 2 — request metadata
		let removedRequests = 0;
		if (
			typeof requestRetentionMs === "number" &&
			Number.isFinite(requestRetentionMs)
		) {
			const requestCutoff = now - requestRetentionMs;
			removedRequests = await this.requests.deleteOlderThan(requestCutoff);
		}

		return {
			removedRequests,
			removedPayloads: removedPayloadsByAge + removedOrphans,
		};
	}

	async getTableRowCounts(): Promise<
		Array<{ name: string; rowCount: number; dataBytes?: number }>
	> {
		if (!this.adapter.isSQLite) {
			return [];
		}
		try {
			const tables = await this.adapter.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			);
			const rows = await Promise.all(
				tables.map(async ({ name }) => {
					const countRow = await this.adapter.get<{ rowCount: number }>(
						`SELECT COUNT(*) AS rowCount FROM "${name}"`,
					);
					const rowCount = countRow?.rowCount ?? 0;
					// Measure actual data bytes for tables with known large text/blob columns
					if (name === "request_payloads") {
						const sizeRow = await this.adapter.get<{ dataBytes: number }>(
							`SELECT SUM(LENGTH(json)) AS dataBytes FROM "${name}"`,
						);
						return { name, rowCount, dataBytes: sizeRow?.dataBytes ?? 0 };
					}
					return { name, rowCount };
				}),
			);
			// Sort: tables with dataBytes first (largest first), then by rowCount
			return rows.sort((a, b) => {
				if (a.dataBytes !== undefined && b.dataBytes !== undefined)
					return b.dataBytes - a.dataBytes;
				if (a.dataBytes !== undefined) return -1;
				if (b.dataBytes !== undefined) return 1;
				return b.rowCount - a.rowCount;
			});
		} catch (err) {
			console.debug("[getTableRowCounts] query failed:", err);
			return [];
		}
	}

	async getDbSizeBytes(): Promise<number> {
		if (!this.adapter.isSQLite || !this.resolvedDbPath) {
			return 0;
		}
		try {
			const { size } = await stat(this.resolvedDbPath);
			return size;
		} catch (err) {
			console.debug("[getDbSizeBytes] stat failed:", err);
			return 0;
		}
	}

	// Agent preference operations delegated to repository
	async getAgentPreference(agentId: string): Promise<{ model: string } | null> {
		return this.agentPreferences.getPreference(agentId);
	}

	async getAllAgentPreferences(): Promise<
		Array<{ agent_id: string; model: string }>
	> {
		return this.agentPreferences.getAllPreferences();
	}

	async setAgentPreference(agentId: string, model: string): Promise<void> {
		await this.agentPreferences.setPreference(agentId, model);
	}

	async deleteAgentPreference(agentId: string): Promise<boolean> {
		return this.agentPreferences.deletePreference(agentId);
	}

	async setBulkAgentPreferences(
		agentIds: string[],
		model: string,
	): Promise<void> {
		await this.agentPreferences.setBulkPreferences(agentIds, model);
	}

	async close(): Promise<void> {
		await this.adapter.close();
	}

	async dispose(): Promise<void> {
		await this.close();
	}

	// Optimize database periodically to maintain performance (SQLite only)
	optimize(): void {
		if (this.sqliteDb) {
			this.sqliteDb.exec("PRAGMA optimize");
			this.sqliteDb.exec("PRAGMA wal_checkpoint(PASSIVE)");
		}
	}

	/**
	 * One-time migration: promote the DB from auto_vacuum=NONE (mode 0) to
	 * INCREMENTAL (mode 2).
	 *
	 * Fresh DBs are born in INCREMENTAL mode via `ensureSchema()`'s leading
	 * `PRAGMA auto_vacuum = INCREMENTAL`. Existing DBs created before that
	 * line was added show `PRAGMA auto_vacuum = 0` in their header — the
	 * PRAGMA from `ensureSchema()` has no effect on a non-empty DB until the
	 * next VACUUM rewrites every page. This method does that VACUUM exactly
	 * once, blocking the caller.
	 *
	 * **Only migrates mode 0 → 2.** A DB at mode 1 (FULL) is an explicit
	 * operator choice — FULL reclaims pages immediately on every COMMIT
	 * whereas INCREMENTAL only reclaims when the hourly worker tick runs, so
	 * silently promoting mode 1 → 2 would change reclamation timing for a
	 * user who chose FULL on purpose. We leave mode 1 alone and log a
	 * one-line notice instead. (Greptile #230)
	 *
	 * **MUST be called before HTTP binds.** VACUUM is a write transaction
	 * that holds SQLite's single writer slot for the entire rewrite — on a
	 * 15 GB DB on local SSD this can take many minutes. Called from
	 * `apps/server/src/server.ts` startup so the proxy never observes a
	 * blocked writer slot.
	 *
	 * Returns `{ migrated: false }` whenever no work was done — both for the
	 * mode 2 (already INCREMENTAL) and mode 1 (deliberately FULL) cases. The
	 * `modeBefore` field distinguishes them so callers can log appropriately.
	 *
	 * Throws if VACUUM fails (e.g. insufficient disk space — VACUUM needs
	 * roughly 2× the DB size in free space transiently). Surfacing the
	 * failure is the right behavior; the proxy would otherwise start in a
	 * state where periodic incremental reclamation can never run.
	 */
	bootstrapAutoVacuum(): {
		migrated: boolean;
		modeBefore: number;
		modeAfter: number;
		durationMs: number;
	} {
		if (!this.sqliteDb) {
			return {
				migrated: false,
				modeBefore: 0,
				modeAfter: 0,
				durationMs: 0,
			};
		}

		// Resolve modeBefore from two sources, picking the trustworthy one for
		// each case (see `incrementalVacuum()` for the full rationale):
		//   - originalMode != 0: trust the captured value (SQLite quirk leaks
		//     the configureSqlite PRAGMA into post-config queries when the
		//     starting mode was non-zero).
		//   - originalMode === 0: trust a fresh query. Fresh DBs end up at
		//     mode 2 here (PRAGMA applied because file was empty); existing
		//     mode-0 DBs stay at 0 (PRAGMA silently rejected on non-empty
		//     DB). The query distinguishes correctly. (Greptile #230)
		const modeBefore =
			this.originalAutoVacuumMode && this.originalAutoVacuumMode !== 0
				? this.originalAutoVacuumMode
				: (
						this.sqliteDb.query("PRAGMA auto_vacuum").get() as {
							auto_vacuum: number;
						}
					).auto_vacuum;

		// Mode 2 (INCREMENTAL): steady-state, nothing to do.
		// Mode 1 (FULL): operator-chosen, don't silently rewrite their policy.
		// Anything else (= mode 0, NONE): migrate.
		if (modeBefore !== 0) {
			return {
				migrated: false,
				modeBefore,
				modeAfter: modeBefore,
				durationMs: 0,
			};
		}

		const start = Date.now();
		// `ensureSchema()` already ran this PRAGMA, but it's idempotent and a
		// freshly-opened handle may not have absorbed the setting from a prior
		// session. Cheap to re-issue, and removes a "spooky action at a
		// distance" failure mode where the next VACUUM doesn't flip the mode
		// because the PRAGMA wasn't actually set on this connection.
		this.sqliteDb.exec("PRAGMA auto_vacuum = INCREMENTAL");
		this.sqliteDb.exec("VACUUM");

		const { auto_vacuum: modeAfter } = this.sqliteDb
			.query("PRAGMA auto_vacuum")
			.get() as { auto_vacuum: number };

		// VACUUM committed the new mode to the header, so update our captured
		// value too — otherwise a second `bootstrapAutoVacuum()` call (rare,
		// but possible in tests) would re-trigger the VACUUM because the old
		// captured mode would still say 0.
		this.originalAutoVacuumMode = modeAfter;

		return {
			migrated: true,
			modeBefore,
			modeAfter,
			durationMs: Date.now() - start,
		};
	}

	/** Compact and reclaim disk space (SQLite only).
	 *
	 * In WAL mode the sequence is:
	 *  1. RESTART checkpoint — flushes all WAL frames back into the main file
	 *     and resets the WAL write position.  Returns (busy, log, checkpointed).
	 *     If busy > 0 another connection still holds a read lock; we still proceed
	 *     so that VACUUM compacts what it can, but we log the fact.
	 *  2. VACUUM — rewrites the main database file to reclaim free pages.
	 *     In WAL mode this is safe to run while the WAL exists; it issues its own
	 *     internal checkpoint before rebuilding.
	 *  3. TRUNCATE checkpoint — resets the WAL file to zero bytes after VACUUM.
	 *
	 * @returns diagnostic info about the checkpoint and whether vacuum ran.
	 */
	async compact(): Promise<{
		walBusy: number;
		walLog: number;
		walCheckpointed: number;
		vacuumed: boolean;
		walTruncateBusy?: number;
		error?: string;
	}> {
		if (!this.sqliteDb || !this.resolvedDbPath) {
			return { walBusy: 0, walLog: 0, walCheckpointed: 0, vacuumed: false };
		}

		if (this.compacting) {
			return {
				walBusy: 0,
				walLog: 0,
				walCheckpointed: 0,
				vacuumed: false,
				error: "Compaction already in progress",
			};
		}

		// Run the WAL checkpoint + VACUUM + TRUNCATE sequence in a Worker thread
		// so the main Bun event loop stays free to serve health checks and other
		// requests during what can be a minutes-long exclusive DB operation.
		const dbPath = this.resolvedDbPath;
		let worker: Worker;
		if (EMBEDDED_VACUUM_WORKER_CODE) {
			const workerCode = Buffer.from(
				EMBEDDED_VACUUM_WORKER_CODE,
				"base64",
			).toString("utf8");
			const blob = new Blob([workerCode], { type: "text/javascript" });
			worker = new Worker(URL.createObjectURL(blob), { smol: true });
		} else {
			worker = new Worker(new URL("./vacuum-worker.ts", import.meta.url).href);
		}
		this.compacting = true;

		try {
			const result = await new Promise<{
				ok: boolean;
				walBusy?: number;
				walLog?: number;
				walCheckpointed?: number;
				walTruncateBusy?: number;
				error?: string;
			}>((resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message));
				worker.postMessage({
					dbPath,
					busyTimeoutMs: this.dbConfig.busyTimeoutMs ?? 10000,
				});
			});

			if (!result.ok) {
				const msg = result.error ?? "Unknown error in vacuum worker";
				console.error(`[compact] Database compaction failed: ${msg}`);
				return {
					walBusy: result.walBusy ?? 0,
					walLog: result.walLog ?? 0,
					walCheckpointed: result.walCheckpointed ?? 0,
					vacuumed: false,
					walTruncateBusy: result.walTruncateBusy,
					error: msg,
				};
			}

			return {
				walBusy: result.walBusy ?? 0,
				walLog: result.walLog ?? 0,
				walCheckpointed: result.walCheckpointed ?? 0,
				vacuumed: true,
				walTruncateBusy: result.walTruncateBusy,
			};
		} finally {
			this.compacting = false;
			worker.terminate();
		}
	}

	/**
	 * Incremental vacuum — reclaims a bounded number of free pages back to the
	 * OS. Off-loaded to a Worker thread so the main JS event loop stays free
	 * while the operation holds the SQLite writer slot.
	 *
	 * Refuses if `auto_vacuum != 2` (INCREMENTAL). The previous implementation
	 * silently bootstrapped INCREMENTAL mode by running a full `VACUUM` inline,
	 * which on a multi-GB DB rewrote the entire file on the main thread and
	 * froze the proxy for many minutes. Fresh DBs are now born in INCREMENTAL
	 * mode via `ensureSchema()`; existing DBs upgraded from auto_vacuum=NONE
	 * are migrated at startup before HTTP binds (see runBootstrapAutoVacuum in
	 * apps/server/src/server.ts). This method therefore expects mode 2 and
	 * logs a one-line warning otherwise — no destructive fallback.
	 *
	 * Returns a Promise; callers that don't need to await can ignore it. The
	 * inner worker handles its own errors and posts them back as
	 * `{ok: false, error}` — we surface them via the returned promise rather
	 * than throwing, so a transient failure doesn't crash the hourly tick.
	 */
	async incrementalVacuum(pages = 8000): Promise<void> {
		if (!this.sqliteDb || !this.resolvedDbPath) return;

		// Resolve the effective auto_vacuum mode. The captured `originalMode`
		// is the on-disk value at handle-open time; configureSqlite then
		// issued `PRAGMA auto_vacuum = INCREMENTAL`. Two cases:
		//
		//   - originalMode != 0: SQLite quirk — the PRAGMA flips the
		//     connection-local query result to 2 even though the on-disk
		//     header can't change without a VACUUM. We trust `originalMode`.
		//
		//   - originalMode === 0: the PRAGMA either took effect (fresh DB,
		//     header now 2) or was silently rejected (non-empty mode-0 DB,
		//     header still 0). In this case the fresh PRAGMA query is
		//     reliable — it returns 0 if rejected, 2 if applied.
		//
		// (Greptile #230)
		const autoVacuum =
			this.originalAutoVacuumMode && this.originalAutoVacuumMode !== 0
				? this.originalAutoVacuumMode
				: (
						this.sqliteDb.query("PRAGMA auto_vacuum").get() as {
							auto_vacuum: number;
						}
					).auto_vacuum;
		if (autoVacuum !== 2) {
			// One-line debug; the loud startup-time warning in the bootstrap
			// path is the right place to flag this. Repeating a WARN every
			// hour would spam logs without adding signal.
			console.debug(
				`[incrementalVacuum] skipped — auto_vacuum=${autoVacuum}; expected 2 (INCREMENTAL). ` +
					`Run startup bootstrap migration to enable incremental reclamation.`,
			);
			return;
		}

		const dbPath = this.resolvedDbPath;
		let worker: Worker;
		if (EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE) {
			const workerCode = Buffer.from(
				EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE,
				"base64",
			).toString("utf8");
			const blob = new Blob([workerCode], { type: "text/javascript" });
			worker = new Worker(URL.createObjectURL(blob), { smol: true });
		} else {
			worker = new Worker(
				new URL("./incremental-vacuum-worker.ts", import.meta.url).href,
			);
		}

		try {
			const result = await new Promise<
				{ ok: true; mode: number } | { ok: false; error: string }
			>((resolve, reject) => {
				worker.onmessage = (event: MessageEvent) => resolve(event.data);
				worker.onerror = (event: ErrorEvent) =>
					reject(new Error(event.message ?? "incremental-vacuum worker error"));
				worker.postMessage({ dbPath, pages });
			});
			if (result.ok) {
				this.incVacuumConsecutiveSkips = 0;
			} else {
				this.incVacuumConsecutiveSkips += 1;
				// Single-tick failures are common and noise — sustained skips
				// across several hourly ticks mean the DB isn't getting any
				// reclamation, which can let free pages accumulate without
				// bound. Escalate after 3 consecutive skips (= 3 hours of
				// missed reclamation). (Greptile #230)
				if (this.incVacuumConsecutiveSkips >= INC_VAC_SKIP_ESCALATE_AT) {
					console.warn(
						`[incrementalVacuum] worker error (${this.incVacuumConsecutiveSkips} consecutive ` +
							`skips, ≈${this.incVacuumConsecutiveSkips}h of missed reclamation): ` +
							`${result.error}. ` +
							`Sustained SQLITE_BUSY suggests writer-slot contention — investigate ` +
							`whether long-running writers (large DELETEs, manual maintenance) are ` +
							`overlapping the hourly tick.`,
					);
				} else {
					console.warn(`[incrementalVacuum] worker error: ${result.error}`);
				}
			}
		} finally {
			worker.terminate();
		}
	}

	/**
	 * Read `PRAGMA freelist_count` — the number of free pages currently on the
	 * SQLite freelist (deleted-but-not-yet-reclaimed pages). Returns 0 when not
	 * in SQLite mode or no handle is open. Synchronous, like the other small
	 * pragma readers in this file.
	 */
	getFreelistCount(): number {
		if (!this.sqliteDb) return 0;
		const result = this.sqliteDb.query("PRAGMA freelist_count").get() as {
			freelist_count: number;
		};
		return result.freelist_count;
	}

	/**
	 * Adaptive incremental vacuum — the unattended hourly backstop.
	 *
	 * With auto_vacuum=INCREMENTAL, deleted pages go to the freelist and are
	 * reused by new inserts; the file only shrinks when we return surplus free
	 * pages to the OS via `PRAGMA incremental_vacuum`. A fixed 8000-page chunk
	 * per hour is fine in steady state, but after a retention *drop* the
	 * freelist can hold hundreds of thousands of pages — at 8000/hour that file
	 * shrinks over weeks. This method instead scales reclaim with the current
	 * freelist so the file recovers over hours.
	 *
	 * It does NOT reclaim everything in one transaction. It drives the
	 * single-chunk `incrementalVacuum()` primitive repeatedly:
	 *   - each worker call reclaims at most `chunkPages` (~64 MiB at 4 KiB),
	 *     bounding how long any one write transaction holds SQLite's single
	 *     writer slot;
	 *   - a per-tick ceiling of `maxPagesPerTick` (~1 GiB) caps total reclaim
	 *     for one hourly tick;
	 *   - between chunks we yield (`setTimeout(25)`) so concurrent proxy writes
	 *     (rate-limit updates, OAuth refresh, post-processor inserts) can
	 *     interleave and aren't starved.
	 *
	 * This keeps the LIVE proxy responsive while still draining a large
	 * surplus over a handful of ticks. For a large *immediate* reclaim, the
	 * one-off `scripts/shrink-db.sh` is the fast path; this is the hands-off
	 * backstop.
	 *
	 * A STALL GUARD breaks the loop if a chunk fails to decrease the freelist
	 * (e.g. auto_vacuum != 2 makes `incrementalVacuum()` a no-op, or writer
	 * contention prevents progress) so we never spin on a no-op.
	 *
	 * `reclaimedPages` is the actual freelist delta across the whole call
	 * (first reading minus last, clamped at >= 0). Under concurrent inserts
	 * this is approximate — new deletes can re-grow the freelist mid-call — but
	 * it's a faithful "how much did the file shrink" signal for logging.
	 */
	async incrementalVacuumAdaptive(opts?: {
		maxPagesPerTick?: number;
		chunkPages?: number;
	}): Promise<{ reclaimedPages: number; chunks: number }> {
		if (!this.sqliteDb || !this.resolvedDbPath) {
			return { reclaimedPages: 0, chunks: 0 };
		}

		const MAX = opts?.maxPagesPerTick ?? 262144; // ~1 GiB at 4 KiB pages — per-tick reclaim ceiling
		const CHUNK = opts?.chunkPages ?? 16384; // ~64 MiB per worker call — bounds each writer-slot hold

		const initialFreelist = this.getFreelistCount();
		let freelist = initialFreelist;
		if (freelist <= 0) {
			// Nothing to reclaim — steady state. Avoid spawning a worker.
			return { reclaimedPages: 0, chunks: 0 };
		}

		const budget = Math.min(freelist, MAX);
		let requestedPages = 0;
		let chunks = 0;

		while (requestedPages < budget && freelist > 0) {
			const n = Math.min(CHUNK, budget - requestedPages);
			const before = this.getFreelistCount();
			await this.incrementalVacuum(n); // one bounded worker txn
			const after = this.getFreelistCount();
			requestedPages += n;
			chunks += 1;

			// STALL GUARD: if the freelist didn't shrink, further chunks won't
			// either (no-op auto_vacuum mode, or writer contention). Stop rather
			// than spin.
			if (after >= before) {
				break;
			}

			freelist = after;

			// More work to do — yield the writer slot briefly so concurrent
			// proxy writes can interleave between chunks.
			if (requestedPages < budget && freelist > 0) {
				await new Promise((r) => setTimeout(r, 25));
			}
		}

		const finalFreelist = this.getFreelistCount();
		const reclaimedPages = Math.max(0, initialFreelist - finalFreelist);
		return { reclaimedPages, chunks };
	}

	// API Key operations delegated to repository
	async getApiKeys() {
		return withDatabaseRetry(
			() => this.apiKeys.findAll(),
			this.retryConfig,
			"getApiKeys",
		);
	}

	async getActiveApiKeys() {
		return withDatabaseRetry(
			() => this.apiKeys.findActive(),
			this.retryConfig,
			"getActiveApiKeys",
		);
	}

	async getApiKey(id: string) {
		return withDatabaseRetry(
			() => this.apiKeys.findById(id),
			this.retryConfig,
			"getApiKey",
		);
	}

	async getApiKeyByHashedKey(hashedKey: string) {
		return withDatabaseRetry(
			() => this.apiKeys.findByHashedKey(hashedKey),
			this.retryConfig,
			"getApiKeyByHashedKey",
		);
	}

	async getApiKeyByName(name: string) {
		return withDatabaseRetry(
			() => this.apiKeys.findByName(name),
			this.retryConfig,
			"getApiKeyByName",
		);
	}

	async apiKeyNameExists(name: string): Promise<boolean> {
		return withDatabaseRetry(
			() => this.apiKeys.nameExists(name),
			this.retryConfig,
			"apiKeyNameExists",
		);
	}

	async createApiKey(apiKey: {
		id: string;
		name: string;
		hashedKey: string;
		prefixLast8: string;
		createdAt: number;
		lastUsed?: number | null;
		isActive: boolean;
		role?: "admin" | "api-only";
	}): Promise<void> {
		await withDatabaseRetry(
			() =>
				this.apiKeys.create({
					id: apiKey.id,
					name: apiKey.name,
					hashed_key: apiKey.hashedKey,
					prefix_last_8: apiKey.prefixLast8,
					created_at: apiKey.createdAt,
					last_used: apiKey.lastUsed || null,
					is_active: apiKey.isActive ? 1 : 0,
					role: apiKey.role || "api-only",
				}),
			this.retryConfig,
			"createApiKey",
		);
	}

	async updateApiKeyUsage(id: string, timestamp: number): Promise<void> {
		await withDatabaseRetry(
			() => this.apiKeys.updateUsage(id, timestamp),
			this.retryConfig,
			"updateApiKeyUsage",
		);
	}

	async disableApiKey(id: string): Promise<boolean> {
		return withDatabaseRetry(
			() => this.apiKeys.disable(id),
			this.retryConfig,
			"disableApiKey",
		);
	}

	async enableApiKey(id: string): Promise<boolean> {
		return withDatabaseRetry(
			() => this.apiKeys.enable(id),
			this.retryConfig,
			"enableApiKey",
		);
	}

	async deleteApiKey(id: string): Promise<boolean> {
		return withDatabaseRetry(
			() => this.apiKeys.delete(id),
			this.retryConfig,
			"deleteApiKey",
		);
	}

	async updateApiKeyRole(
		id: string,
		role: "admin" | "api-only",
	): Promise<boolean> {
		return withDatabaseRetry(
			() => this.apiKeys.updateRole(id, role),
			this.retryConfig,
			"updateApiKeyRole",
		);
	}

	async countActiveApiKeys(): Promise<number> {
		return withDatabaseRetry(
			() => this.apiKeys.countActive(),
			this.retryConfig,
			"countActiveApiKeys",
		);
	}

	async countAllApiKeys(): Promise<number> {
		return withDatabaseRetry(
			() => this.apiKeys.countAll(),
			this.retryConfig,
			"countAllApiKeys",
		);
	}

	/**
	 * Clear all API keys (for testing purposes)
	 */
	async clearApiKeys(): Promise<void> {
		await withDatabaseRetry(
			() => this.apiKeys.clearAll(),
			this.retryConfig,
			"clearApiKeys",
		);
	}

	/**
	 * Get the API key repository for direct access
	 */
	getApiKeyRepository(): ApiKeyRepository {
		return this.apiKeys;
	}

	/**
	 * Get the stats repository for consolidated stats access
	 */
	getStatsRepository(): StatsRepository {
		return this.stats;
	}

	// ── Combo operations delegated to repository ──────────────────────────────

	async createCombo(name: string, description?: string | null): Promise<Combo> {
		return this.combo.create(name, description);
	}

	async listCombos(): Promise<Combo[]> {
		return this.combo.findAll();
	}

	async getCombo(id: string): Promise<Combo | null> {
		return this.combo.findById(id);
	}

	async updateCombo(
		id: string,
		fields: Partial<{
			name: string;
			description: string | null;
			enabled: boolean;
		}>,
	): Promise<Combo> {
		return this.combo.update(id, fields);
	}

	async deleteCombo(id: string): Promise<void> {
		await this.combo.delete(id);
	}

	async addComboSlot(
		comboId: string,
		accountId: string,
		model: string,
		priority: number,
	): Promise<ComboSlot> {
		return this.combo.addSlot(comboId, accountId, model, priority);
	}

	async updateComboSlot(
		slotId: string,
		fields: Partial<{ model: string; priority: number; enabled: boolean }>,
	): Promise<ComboSlot> {
		return this.combo.updateSlot(slotId, fields);
	}

	async removeComboSlot(slotId: string): Promise<void> {
		await this.combo.removeSlot(slotId);
	}

	async getComboSlots(comboId: string): Promise<ComboSlot[]> {
		return this.combo.getSlots(comboId);
	}

	async reorderComboSlots(comboId: string, slotIds: string[]): Promise<void> {
		await this.combo.reorderSlots(comboId, slotIds);
	}

	async setFamilyCombo(
		family: ComboFamily,
		comboId: string | null,
		enabled: boolean,
	): Promise<void> {
		await this.combo.setFamilyAssignment(family, comboId, enabled);
	}

	async getFamilyAssignments(): Promise<ComboFamilyAssignment[]> {
		return this.combo.getFamilyAssignments();
	}

	async getActiveComboForFamily(
		family: ComboFamily,
	): Promise<ComboWithSlots | null> {
		return this.combo.getActiveComboForFamily(family);
	}
}
