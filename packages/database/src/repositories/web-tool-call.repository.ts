import { randomUUID } from "node:crypto";
import {
	toWebToolCall,
	toWebToolCallSummary,
	type WebToolCall,
	type WebToolCallRow,
	type WebToolCallStatus,
	type WebToolCallSummary,
	type WebToolCallSummaryRow,
	type WebToolCallWriteInput,
} from "@better-ccflare/types";
import { getCleanupBatchSize } from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

const SELECT_COLUMNS = `
	id, timestamp, tool, provider_id, provider_kind, account_id, project,
	query_text, query_chars, result_count, latency_ms, status, error_code,
	estimated_cost_usd`;

export interface WebToolCallListFilters {
	status?: WebToolCallStatus;
	providerKind?: string;
	/** Epoch ms; only rows at or after this are returned. */
	since?: number;
}

/**
 * Repository for the `web_tool_calls` table — one row per web tool call the
 * proxy intercepted (`web_search` today, `web_fetch` later).
 *
 * Portability notes (SQLite + PostgreSQL share every statement below):
 * - The summary groups by select-list ordinals (`GROUP BY 1, 2`), never by
 *   an expression that also carries a bind parameter — convertPlaceholders()
 *   renumbers each `?` separately and PG rejects the mismatch (SQLSTATE 42803).
 * - No `?` appears inside a SQL comment.
 * - PG returns BIGINT columns as strings; {@link toWebToolCall} coerces them.
 */
export class WebToolCallRepository extends BaseRepository<WebToolCall> {
	/** Insert one call. Generates the id and timestamp. */
	async record(input: WebToolCallWriteInput): Promise<void> {
		await this.run(
			`INSERT INTO web_tool_calls (
				id, timestamp, tool, provider_id, provider_kind, account_id,
				project, query_text, query_chars, result_count, latency_ms,
				status, error_code
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				randomUUID(),
				Date.now(),
				input.tool,
				input.providerId ?? null,
				input.providerKind ?? null,
				input.accountId ?? null,
				input.project ?? null,
				input.queryText ?? null,
				input.queryChars,
				input.resultCount ?? null,
				input.latencyMs,
				input.status,
				input.errorCode ?? null,
			],
		);
	}

	/** Newest first, at most `limit` rows. */
	async listRecent(
		limit: number,
		filters: WebToolCallListFilters = {},
	): Promise<WebToolCall[]> {
		const where: string[] = [];
		const params: unknown[] = [];
		if (filters.status !== undefined) {
			where.push("status = ?");
			params.push(filters.status);
		}
		if (filters.providerKind !== undefined) {
			where.push("provider_kind = ?");
			params.push(filters.providerKind);
		}
		if (filters.since !== undefined) {
			where.push("timestamp >= ?");
			params.push(filters.since);
		}
		params.push(limit);

		const rows = await this.query<WebToolCallRow>(
			`SELECT ${SELECT_COLUMNS} FROM web_tool_calls
			 ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY timestamp DESC, id DESC
			 LIMIT ?`,
			params,
		);
		return rows.map(toWebToolCall);
	}

	/**
	 * Per `(provider_kind, status)` bucket since `since`: call count, total
	 * and average latency, and total results. Ordered by call count DESC for
	 * a stable, most-interesting-first listing. Cost is deliberately not
	 * aggregated — `estimated_cost_usd` is an unused placeholder.
	 */
	async summary(since: number): Promise<WebToolCallSummary[]> {
		const rows = await this.query<WebToolCallSummaryRow>(
			`SELECT provider_kind, status,
				COUNT(*) AS call_count,
				COALESCE(SUM(latency_ms), 0) AS total_latency_ms,
				COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
				COALESCE(SUM(result_count), 0) AS total_results
			 FROM web_tool_calls
			 WHERE timestamp >= ?
			 GROUP BY 1, 2
			 ORDER BY call_count DESC, provider_kind ASC, status ASC`,
			[since],
		);
		return rows.map(toWebToolCallSummary);
	}

	/** Number of rows with `timestamp >= since`. */
	async countSince(since: number): Promise<number> {
		const row = await this.get(
			`SELECT COUNT(*) AS n FROM web_tool_calls WHERE timestamp >= ?`,
			[since],
		);
		// Read as an untyped row: the PG driver returns COUNT(*) (int8) as a
		// string, and naming that key in a destructure would be coerced at a
		// different point than the rest of the mapper.
		const n = (row as { n?: number | string | null } | null)?.n;
		return Number(n ?? 0);
	}

	/**
	 * Delete rows with `timestamp < cutoff`; returns the number removed.
	 *
	 * Batched like the request/usage-history cleanups: an unbounded DELETE can
	 * exceed the PostgreSQL statement_timeout after a backlog or a shortened
	 * retention setting, and then rolls back everything it had done. Batch size
	 * is configurable via BETTER_CCFLARE_DB_CLEANUP_BATCH_SIZE.
	 */
	async deleteOlderThan(cutoff: number): Promise<number> {
		const BATCH_SIZE = getCleanupBatchSize();
		let total = 0;
		let deleted: number;
		do {
			deleted = await this.runWithChanges(
				`DELETE FROM web_tool_calls WHERE id IN (
					SELECT id FROM web_tool_calls WHERE timestamp < ? LIMIT ?
				)`,
				[cutoff, BATCH_SIZE],
			);
			total += deleted;
		} while (deleted === BATCH_SIZE);
		return total;
	}
}
