import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeConfig } from "@better-ccflare/config";
import type { Disposable } from "@better-ccflare/core";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import type {
	Account,
	Combo,
	ComboFamily,
	ComboFamilyAssignment,
	ComboSlot,
	ComboWithSlots,
	IntegrityStatus,
	RateLimitReason,
	StrategyStore,
} from "@better-ccflare/types";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
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
 * Apply SQLite pragmas for optimal performance on distributed filesystems
 */
function configureSqlite(
	db: Database,
	config: DatabaseConfig,
	skipIntegrityCheck = false,
): void {
	try {
		// Check database integrity first (skip in fast mode for CLI commands)
		if (!skipIntegrityCheck) {
			const integrityResult = db.query("PRAGMA integrity_check").get() as {
				integrity_check: string;
			};
			if (integrityResult.integrity_check !== "ok") {
				console.error("\n❌ DATABASE INTEGRITY CHECK FAILED");
				console.error("═".repeat(50));
				console.error(`Error: ${integrityResult.integrity_check}\n`);
				console.error("Your database may be corrupted. To repair it, run:");
				console.error("  bun run cli --repair-db\n");
				console.error(`${"═".repeat(50)}\n`);
				throw new Error(
					`Database integrity check failed: ${integrityResult.integrity_check}`,
				);
			}
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

		// Configure memory-mapped I/O (disable on distributed filesystems if problematic)
		if (config.mmapSize !== undefined && config.mmapSize > 0) {
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
	/** Prevents concurrent compact() calls from spawning multiple vacuum workers */
	private compacting = false;
	private runtime?: RuntimeConfig;
	private dbConfig: DatabaseConfig;
	private retryConfig: DatabaseRetryConfig;
	private fastMode: boolean;
	readonly isSQLite: boolean;
	/** Cached integrity check status for doctor command */
	private integrityStatus: IntegrityStatus = {
		status: "unchecked",
		lastCheckAt: null,
		lastError: null,
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

	constructor(
		dbPath?: string,
		dbConfig?: DatabaseConfig,
		retryConfig?: DatabaseRetryConfig,
		fastMode = false,
	) {
		this.fastMode = fastMode;

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
			const sqlClient = new SQL({
				url: databaseUrl,
				max: 10,
				idleTimeout: 30,
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

			// Apply SQLite configuration
			configureSqlite(this.sqliteDb, this.dbConfig, fastMode);

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

	/**
	 * Run database integrity check if it was skipped during initialization
	 */
	runIntegrityCheck(): void {
		if (this.fastMode && this.sqliteDb) {
			const integrityResult = this.sqliteDb
				.query("PRAGMA integrity_check")
				.get() as { integrity_check: string };
			if (integrityResult.integrity_check !== "ok") {
				console.error("\n❌ DATABASE INTEGRITY CHECK FAILED");
				console.error("═".repeat(50));
				console.error(`Error: ${integrityResult.integrity_check}\n`);
				console.error("Your database may be corrupted. To repair it, run:");
				console.error("  bun run cli --repair-db\n");
				console.error(`${"═".repeat(50)}\n`);
				throw new Error(
					`Database integrity check failed: ${integrityResult.integrity_check}`,
				);
			}
		}
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

	async runFullIntegrityCheck(): Promise<string> {
		if (!this.sqliteDb) {
			// PostgreSQL: verify connectivity with a lightweight query
			await this.adapter.get("SELECT 1 AS ok");
			return "ok";
		}
		// integrity_check can return multiple rows for long error reports
		const rows = this.sqliteDb.query("PRAGMA integrity_check").all() as Array<{
			integrity_check: string;
		}>;
		// Join all rows into a single string (most cases return single 'ok' row)
		return rows.map((r) => r.integrity_check).join("\n");
	}

	/**
	 * Get cached integrity status
	 */
	getIntegrityStatus(): IntegrityStatus {
		return { ...this.integrityStatus };
	}

	/**
	 * Update cached integrity status
	 */
	updateIntegrityStatus(status: "ok" | "corrupt", error?: string | null): void {
		this.integrityStatus = {
			status,
			lastCheckAt: Date.now(),
			lastError: error ?? null,
		};
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
	): Promise<void> {
		await withDatabaseRetry(
			() => this.accounts.setRateLimited(accountId, until, reason),
			this.retryConfig,
			"markAccountRateLimited",
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

	/** Incremental vacuum - reclaims space without blocking (SQLite only) */
	incrementalVacuum(pages?: number): void {
		if (!this.sqliteDb) return;

		const autoVacuumMode = this.sqliteDb.query("PRAGMA auto_vacuum").get() as {
			auto_vacuum: number;
		};

		if (autoVacuumMode.auto_vacuum !== 2) {
			this.sqliteDb.exec("PRAGMA auto_vacuum = INCREMENTAL");
			this.sqliteDb.exec("VACUUM");
		}

		if (pages) {
			this.sqliteDb.exec(`PRAGMA incremental_vacuum(${pages})`);
		} else {
			this.sqliteDb.exec("PRAGMA incremental_vacuum");
		}
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
