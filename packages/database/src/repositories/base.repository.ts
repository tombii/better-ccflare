import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";

export abstract class BaseRepository<_T> {
	constructor(protected adapter: BunSqlAdapter) {}

	protected async query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
		return this.adapter.query<R>(sql, params);
	}

	protected async get<R>(
		sql: string,
		params: unknown[] = [],
	): Promise<R | null> {
		return this.adapter.get<R>(sql, params);
	}

	protected async run(sql: string, params: unknown[] = []): Promise<void> {
		return this.adapter.run(sql, params);
	}

	protected async runWithChanges(
		sql: string,
		params: unknown[] = [],
	): Promise<number> {
		return this.adapter.runWithChanges(sql, params);
	}
}
