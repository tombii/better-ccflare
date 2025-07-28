import type { Database } from "bun:sqlite";
import { BaseRepository } from "./base.repository";

export interface RequestData {
	id: string;
	method: string;
	path: string;
	accountUsed: string | null;
	statusCode: number | null;
	success: boolean;
	errorMessage: string | null;
	responseTime: number;
	failoverAttempts: number;
	usage?: {
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	};
}

export class RequestRepository extends BaseRepository<RequestData> {
	constructor(db: Database) {
		super(db);
	}

	saveMeta(id: string, method: string, path: string, accountUsed: string | null, statusCode: number | null, timestamp?: number): void {
		this.run(`
			INSERT INTO requests (
				id, timestamp, method, path, account_used, 
				status_code, success, error_message, response_time_ms, failover_attempts
			)
			VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, 0)
		`, [id, timestamp || Date.now(), method, path, accountUsed, statusCode]);
	}

	save(data: RequestData): void {
		const { usage } = data;
		this.run(`
			INSERT OR REPLACE INTO requests (
				id, timestamp, method, path, account_used, 
				status_code, success, error_message, response_time_ms, failover_attempts,
				model, prompt_tokens, completion_tokens, total_tokens, cost_usd,
				input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, [
			data.id,
			Date.now(),
			data.method,
			data.path,
			data.accountUsed,
			data.statusCode,
			data.success ? 1 : 0,
			data.errorMessage,
			data.responseTime,
			data.failoverAttempts,
			usage?.model || null,
			usage?.promptTokens || null,
			usage?.completionTokens || null,
			usage?.totalTokens || null,
			usage?.costUsd || null,
			usage?.inputTokens || null,
			usage?.cacheReadInputTokens || null,
			usage?.cacheCreationInputTokens || null,
			usage?.outputTokens || null,
		]);
	}

	updateUsage(requestId: string, usage: RequestData['usage']): void {
		if (!usage) return;
		
		this.run(`
			UPDATE requests
			SET 
				model = COALESCE(?, model),
				prompt_tokens = COALESCE(?, prompt_tokens),
				completion_tokens = COALESCE(?, completion_tokens),
				total_tokens = COALESCE(?, total_tokens),
				cost_usd = COALESCE(?, cost_usd),
				input_tokens = COALESCE(?, input_tokens),
				cache_read_input_tokens = COALESCE(?, cache_read_input_tokens),
				cache_creation_input_tokens = COALESCE(?, cache_creation_input_tokens),
				output_tokens = COALESCE(?, output_tokens)
			WHERE id = ?
		`, [
			usage.model || null,
			usage.promptTokens || null,
			usage.completionTokens || null,
			usage.totalTokens || null,
			usage.costUsd || null,
			usage.inputTokens || null,
			usage.cacheReadInputTokens || null,
			usage.cacheCreationInputTokens || null,
			usage.outputTokens || null,
			requestId,
		]);
	}

	// Payload management
	savePayload(id: string, data: unknown): void {
		const json = JSON.stringify(data);
		this.run(
			`INSERT OR REPLACE INTO request_payloads (id, json) VALUES (?, ?)`,
			[id, json]
		);
	}

	getPayload(id: string): unknown | null {
		const row = this.get<{ json: string }>(
			`SELECT json FROM request_payloads WHERE id = ?`,
			[id]
		);

		if (!row) return null;

		try {
			return JSON.parse(row.json);
		} catch {
			return null;
		}
	}

	listPayloads(limit = 50): Array<{ id: string; json: string }> {
		return this.query<{ id: string; json: string }>(`
			SELECT rp.id, rp.json 
			FROM request_payloads rp
			JOIN requests r ON rp.id = r.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`, [limit]);
	}

	listPayloadsWithAccountNames(limit = 50): Array<{ id: string; json: string; account_name: string | null }> {
		return this.query<{ id: string; json: string; account_name: string | null }>(`
			SELECT rp.id, rp.json, a.name as account_name
			FROM request_payloads rp
			JOIN requests r ON rp.id = r.id
			LEFT JOIN accounts a ON r.account_used = a.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`, [limit]);
	}
}