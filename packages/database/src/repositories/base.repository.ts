import type { Database } from "bun:sqlite";

export abstract class BaseRepository<_T> {
	constructor(protected db: Database) {}

	protected query<R>(sql: string, params: unknown[] = []): R[] {
		return this.db.query<R, unknown[]>(sql).all(...params) as R[];
	}

	protected get<R>(sql: string, params: unknown[] = []): R | null {
		const result = this.db.query<R, unknown[]>(sql).get(...params);
		return result as R | null;
	}

	protected run(sql: string, params: unknown[] = []): void {
		this.db.run(sql, params);
	}

	protected runWithChanges(sql: string, params: unknown[] = []): number {
		const result = this.db.run(sql, params);
		return result.changes;
	}
}
