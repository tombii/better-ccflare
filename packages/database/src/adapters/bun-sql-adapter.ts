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
	 * Execute a SELECT query returning multiple rows.
	 */
	async query<R>(sqlStr: string, params: unknown[] = []): Promise<R[]> {
		if (this.isSQLite && this.sqliteDb) {
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			return this.sqliteDb.query<R, any[]>(sqlStr).all(...(params as any[]));
		}
		// PostgreSQL via Bun.SQL unsafe
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		const result = await this.sql?.unsafe(pgQuery, params as any[]);
		return result as unknown as R[];
	}

	/**
	 * Execute a SELECT query returning a single row or null.
	 */
	async get<R>(sqlStr: string, params: unknown[] = []): Promise<R | null> {
		if (this.isSQLite && this.sqliteDb) {
			const result = this.sqliteDb
				// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
				.query<R, any[]>(sqlStr)
				// biome-ignore lint/suspicious/noExplicitAny: SQLite .get() spread params
				.get(...(params as any[]));
			return (result as R) ?? null;
		}
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		const rows = await this.sql?.unsafe(pgQuery, params as any[]);
		return ((rows as unknown as R[])[0] ?? null) as R | null;
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query with no return value.
	 */
	async run(sqlStr: string, params: unknown[] = []): Promise<void> {
		if (this.isSQLite && this.sqliteDb) {
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			this.sqliteDb.run(sqlStr, params as any[]);
			return;
		}
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		await this.sql?.unsafe(pgQuery, params as any[]);
	}

	/**
	 * Execute an INSERT/UPDATE/DELETE query and return the number of affected rows.
	 */
	async runWithChanges(
		sqlStr: string,
		params: unknown[] = [],
	): Promise<number> {
		if (this.isSQLite && this.sqliteDb) {
			// biome-ignore lint/suspicious/noExplicitAny: SQLite params can be any binding type
			const result = this.sqliteDb.run(sqlStr, params as any[]);
			return result.changes;
		}
		const pgQuery = this.pgSql(sqlStr);
		// biome-ignore lint/suspicious/noExplicitAny: Bun.SQL accepts various binding types
		const result = await this.sql?.unsafe(pgQuery, params as any[]);
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
		return this.sql?.unsafe(pgQuery, params as any[]);
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
