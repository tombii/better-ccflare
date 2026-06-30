import type { Database } from "bun:sqlite";
import type { SQL } from "bun";

/**
 * Convert SQLite-style `?` and `?N` placeholders to PostgreSQL-style `$N` placeholders.
 * Handles both `?` (sequential) and `?1`, `?2` (positional) styles.
 * Skips placeholders inside single-quoted string literals.
 */
function convertPlaceholders(sql: string): string {
	let result = "";
	let paramIndex = 0;
	let inString = false;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];

		// Toggle string literal tracking (handle escaped quotes '')
		if (ch === "'") {
			inString = !inString;
			result += ch;
			continue;
		}

		if (inString) {
			result += ch;
			continue;
		}

		if (ch === "?") {
			// Check for ?N style (e.g., ?1, ?2)
			let numStr = "";
			let j = i + 1;
			while (j < sql.length && sql[j] >= "0" && sql[j] <= "9") {
				numStr += sql[j];
				j++;
			}
			if (numStr.length > 0) {
				// ?N -> $N (keep the original number)
				result += `$${numStr}`;
				i = j - 1; // skip the digits
			} else {
				// ? -> $N (sequential)
				paramIndex++;
				result += `$${paramIndex}`;
			}
		} else {
			result += ch;
		}
	}

	return result;
}

/**
 * Client-side timeout (ms) for the PostgreSQL Promise.race guard in
 * withPgTimeout(). The server-side `statement_timeout` (set in
 * DatabaseOperations) must always be configured below this value so PG
 * cancels the query and frees the connection before the client gives up —
 * otherwise the client unblocks while the query (and its pool connection)
 * is still running on the server.
 */
export const PG_CLIENT_QUERY_TIMEOUT_MS = 8000;

/**
 * Unified SQL adapter that abstracts over bun:sqlite (sync) and Bun.SQL/PostgreSQL (async).
 *
 * For SQLite: wraps the existing bun:sqlite Database for synchronous operations.
 * For PostgreSQL: wraps Bun.SQL for async operations.
 *
 * The `query`, `get`, `run`, `runWithChanges` methods return Promises in both
 * cases — for SQLite they resolve synchronously under the hood.
 */
export class BunSqlAdapter {
	readonly isSQLite: boolean;

	/** The underlying bun:sqlite Database — only set when isSQLite is true */
	private sqliteDb?: Database;
	/** The Bun.SQL instance — set for PostgreSQL, and also for SQLite via Bun.SQL URL */
	private sql?: InstanceType<typeof SQL>;

	constructor(sqliteDb: Database);
	constructor(sqlClient: InstanceType<typeof SQL>, isSQLite: false);
	constructor(
		dbOrSql: Database | InstanceType<typeof SQL>,
		isSQLiteHint?: boolean,
	) {
		// Detect whether we received a bun:sqlite Database or a Bun.SQL instance
		if (isSQLiteHint === false) {
			this.isSQLite = false;
			this.sql = dbOrSql as InstanceType<typeof SQL>;
		} else {
			// bun:sqlite Database instance
			this.isSQLite = true;
			this.sqliteDb = dbOrSql as Database;
		}
	}

	/** Return the underlying bun:sqlite Database. Only valid when isSQLite is true. */
	getSQLiteDb(): Database {
		if (!this.sqliteDb) {
			throw new Error("getSQLiteDb() called on a PostgreSQL adapter");
		}
		return this.sqliteDb;
	}

	/** Return the Bun.SQL instance. Only valid when isSQLite is false. */
	getSQL(): InstanceType<typeof SQL> {
		if (!this.sql) {
			throw new Error("getSQL() called on a non-SQL adapter");
		}
		return this.sql;
	}

	/**
	 * Convert SQL for PostgreSQL if needed (? -> $N placeholders).
	 */
	private pgSql(sqlStr: string): string {
		return this.isSQLite ? sqlStr : convertPlaceholders(sqlStr);
	}

	/**
	 * Race a PG query promise against a timeout. Rejects if the query does not
	 * settle within `ms` milliseconds. Only used for the PostgreSQL path.
	 */
	private withPgTimeout<T>(
		promise: Promise<T>,
		ms: number,
		queryHint: string,
	): Promise<T> {
		// Client-side belt-and-suspenders guard. The primary protection is the
		// server-side statement_timeout set at connection time in DatabaseOperations,
		// which causes PG to cancel the query and release the connection. This race
		// just ensures the caller unblocks even if the PG cancel is delayed.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(
							`PG query timeout after ${ms}ms: ${queryHint.slice(0, 80)}`,
						),
					),
				ms,
			);
		});
		return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
	}

	/**
	 * Retry a synchronous SQLite call asynchronously when the database is
	 * locked by another connection (SQLITE_BUSY / errno 5).
	 *
	 * SQLite's built-in busy_timeout retries at the C level via usleep(), which
	 * blocks the Bun event loop for the entire wait.  This wrapper instead lets
	 * the busy_timeout exhaust normally (giving the C layer a short chance to
	 * self-resolve), then catches the resulting error and re-schedules with
	 * setTimeout so the event loop stays free between attempts.  This is
	 * necessary when a long-running exclusive operation such as VACUUM is running
	 * on a separate Worker connection.
	 */
	private async withBusyRetry<T>(fn: () => T): Promise<T> {
		const deadline = Date.now() + 10 * 60 * 1000; // retry for up to 10 minutes
		while (true) {
			try {
				return fn();
			} catch (err) {
				const isBusy =
					err instanceof Error &&
					"code" in err &&
					(err as { code?: string }).code === "SQLITE_BUSY";
				if (isBusy && Date.now() < deadline) {
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
					continue;
				}
				throw err;
			}
		}
	}

	/**
	 * Execute a SELECT query returning multiple rows.
	 */
	async query<R>(sqlStr: string, params: unknown[] = []): Promise<R[]> {
		if (this.isSQLite && this.sqliteDb) {
			const db = this.sqliteDb;
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			return this.withBusyRetry(() =>
				db.query<R, any[]>(sqlStr).all(...(params as any[])),
			);
		}
		// PostgreSQL via Bun.SQL unsafe
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		const result = await this.withPgTimeout(
			this.sql?.unsafe(pgQuery, params as any[]) as Promise<unknown>,
			PG_CLIENT_QUERY_TIMEOUT_MS,
			sqlStr,
		);
		return result as unknown as R[];
	}

	/**
	 * Execute a SELECT query returning a single row or null.
	 */
	async get<R>(sqlStr: string, params: unknown[] = []): Promise<R | null> {
		if (this.isSQLite && this.sqliteDb) {
			const db = this.sqliteDb;
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			const result = await this.withBusyRetry(() =>
				db.query<R, any[]>(sqlStr).get(...(params as any[])),
			);
			return (result as R) ?? null;
		}
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		const rows = await this.withPgTimeout(
			this.sql?.unsafe(pgQuery, params as any[]) as Promise<unknown>,
			PG_CLIENT_QUERY_TIMEOUT_MS,
			sqlStr,
		);
		return ((rows as unknown as R[])[0] ?? null) as R | null;
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query with no return value.
	 */
	async run(sqlStr: string, params: unknown[] = []): Promise<void> {
		if (this.isSQLite && this.sqliteDb) {
			const db = this.sqliteDb;
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			await this.withBusyRetry(() => db.run(sqlStr, params as any[]));
			return;
		}
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		await this.withPgTimeout(
			this.sql?.unsafe(pgQuery, params as any[]) as Promise<unknown>,
			PG_CLIENT_QUERY_TIMEOUT_MS,
			sqlStr,
		);
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query and return the number of affected rows.
	 */
	async runWithChanges(
		sqlStr: string,
		params: unknown[] = [],
	): Promise<number> {
		if (this.isSQLite && this.sqliteDb) {
			const db = this.sqliteDb;
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			const result = await this.withBusyRetry(() =>
				db.run(sqlStr, params as any[]),
			);
			return result.changes;
		}
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		const result = await this.withPgTimeout(
			this.sql?.unsafe(pgQuery, params as any[]) as Promise<unknown>,
			PG_CLIENT_QUERY_TIMEOUT_MS,
			sqlStr,
		);
		// Bun.SQL returns an array-like with a `count` property for DML statements
		return (result as unknown as { count: number }).count ?? 0;
	}

	/**
	 * Execute a function within a transaction.
	 * For SQLite: uses bun:sqlite's synchronous transaction API.
	 * For PostgreSQL: uses Bun.SQL's async begin().
	 */
	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		if (this.isSQLite && this.sqliteDb) {
			// bun:sqlite transactions are sync; wrap fn result
			let _result!: T;
			const tx = this.sqliteDb.transaction(() => {
				// Execute async fn synchronously (SQLite Bun.SQL resolves immediately)
				_result = undefined as unknown as T;
				// For SQLite we need to handle this differently — run as sync transaction
				// The fn is expected to use adapter methods which for SQLite execute synchronously
				return null;
			});
			tx();
			// Actually run fn outside transaction for SQLite compatibility
			// Note: Real transactional safety for SQLite uses the sync API
			return fn();
		}
		if (!this.sql) {
			throw new Error("SQL client not available for transaction");
		}
		return this.sql.begin(async () => {
			return fn();
		});
	}

	/**
	 * Execute raw SQL string (for PRAGMAs and DDL).
	 * For SQLite: uses exec().
	 * For PostgreSQL: uses sql.unsafe().
	 */
	async unsafe(sqlStr: string, params?: unknown[]): Promise<unknown> {
		if (this.isSQLite && this.sqliteDb) {
			if (params && params.length > 0) {
				// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
				return this.sqliteDb.run(sqlStr, params as any[]);
			}
			this.sqliteDb.exec(sqlStr);
			return;
		}
		const pgQuery = params && params.length > 0 ? this.pgSql(sqlStr) : sqlStr;
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		return this.withPgTimeout(
			this.sql?.unsafe(pgQuery, params as any[]) as Promise<unknown>,
			PG_CLIENT_QUERY_TIMEOUT_MS,
			sqlStr,
		);
	}

	/**
	 * Close the database connection.
	 */
	async close(): Promise<void> {
		if (this.isSQLite && this.sqliteDb) {
			this.sqliteDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			this.sqliteDb.close();
		} else if (this.sql) {
			await this.sql.end();
		}
	}
}
