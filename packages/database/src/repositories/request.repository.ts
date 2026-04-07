import { Logger } from "@better-ccflare/logger";
import { decryptPayload, encryptPayload } from "../payload-encryption";
import { BaseRepository } from "./base.repository";

const log = new Logger("RequestRepository");

/**
 * Decrypt a stored payload for a list endpoint, swallowing per-row errors
 * so a single corrupted/tampered row cannot take down the whole list.
 *
 * The error is logged so misconfiguration is still observable, and a JSON
 * placeholder is substituted that the dashboard can render as "unreadable".
 *
 * Single-row reads (`getPayload`) MUST stay strict and let the error
 * propagate — there's no fallback that makes sense for a single row.
 */
async function decryptForList(id: string, json: string): Promise<string> {
	try {
		return await decryptPayload(json);
	} catch (err) {
		log.error(`Failed to decrypt payload ${id}:`, err);
		return JSON.stringify({
			error: "Payload could not be decrypted",
			id,
		});
	}
}

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
	agentUsed?: string;
	apiKeyId?: string;
	apiKeyName?: string;
	project?: string | null;
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
		tokensPerSecond?: number;
	};
}

export class RequestRepository extends BaseRepository<RequestData> {
	async saveMeta(
		id: string,
		method: string,
		path: string,
		accountUsed: string | null,
		statusCode: number | null,
		timestamp?: number,
		apiKeyId?: string,
		apiKeyName?: string,
		project?: string | null,
	): Promise<void> {
		await this.run(
			`
			INSERT INTO requests (
				id, timestamp, method, path, account_used,
				status_code, success, error_message, response_time_ms, failover_attempts,
				api_key_id, api_key_name, project
			)
			VALUES (?, ?, ?, ?, ?, ?, FALSE, NULL, 0, 0, ?, ?, ?)
		`,
			[
				id,
				timestamp || Date.now(),
				method,
				path,
				accountUsed,
				statusCode,
				apiKeyId || null,
				apiKeyName || null,
				project || null,
			],
		);
	}

	async save(data: RequestData): Promise<void> {
		const { usage } = data;
		await this.run(
			`
			INSERT INTO requests (
				id, timestamp, method, path, account_used,
				status_code, success, error_message, response_time_ms, failover_attempts,
				model, prompt_tokens, completion_tokens, total_tokens, cost_usd,
				input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
				agent_used, output_tokens_per_second, api_key_id, api_key_name, project
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				timestamp = EXCLUDED.timestamp,
				method = EXCLUDED.method,
				path = EXCLUDED.path,
				account_used = EXCLUDED.account_used,
				status_code = EXCLUDED.status_code,
				success = EXCLUDED.success,
				error_message = EXCLUDED.error_message,
				response_time_ms = EXCLUDED.response_time_ms,
				failover_attempts = EXCLUDED.failover_attempts,
				model = EXCLUDED.model,
				prompt_tokens = EXCLUDED.prompt_tokens,
				completion_tokens = EXCLUDED.completion_tokens,
				total_tokens = EXCLUDED.total_tokens,
				cost_usd = EXCLUDED.cost_usd,
				input_tokens = EXCLUDED.input_tokens,
				cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
				cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
				output_tokens = EXCLUDED.output_tokens,
				agent_used = EXCLUDED.agent_used,
				output_tokens_per_second = EXCLUDED.output_tokens_per_second,
				api_key_id = EXCLUDED.api_key_id,
				api_key_name = EXCLUDED.api_key_name,
				project = COALESCE(EXCLUDED.project, requests.project)
		`,
			[
				data.id,
				Date.now(),
				data.method,
				data.path,
				data.accountUsed,
				data.statusCode,
				data.success,
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
				data.agentUsed || null,
				usage?.tokensPerSecond || null,
				data.apiKeyId || null,
				data.apiKeyName || null,
				data.project || null,
			],
		);
	}

	async updateUsage(
		requestId: string,
		usage: RequestData["usage"],
	): Promise<void> {
		if (!usage) return;

		await this.run(
			`
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
				output_tokens = COALESCE(?, output_tokens),
				output_tokens_per_second = COALESCE(?, output_tokens_per_second)
			WHERE id = ?
		`,
			[
				usage.model || null,
				usage.promptTokens || null,
				usage.completionTokens || null,
				usage.totalTokens || null,
				usage.costUsd || null,
				usage.inputTokens || null,
				usage.cacheReadInputTokens || null,
				usage.cacheCreationInputTokens || null,
				usage.outputTokens || null,
				usage.tokensPerSecond || null,
				requestId,
			],
		);
	}

	// Payload management
	async savePayload(id: string, data: unknown): Promise<void> {
		const json = JSON.stringify(data);
		const stored = await encryptPayload(json);
		const ts = Date.now();
		await this.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, timestamp = EXCLUDED.timestamp`,
			[id, stored, ts],
		);
	}

	async savePayloadRaw(id: string, json: string): Promise<void> {
		const stored = await encryptPayload(json);
		const ts = Date.now();
		await this.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json, timestamp = EXCLUDED.timestamp`,
			[id, stored, ts],
		);
	}

	async getPayload(id: string): Promise<unknown | null> {
		const row = await this.get<{ json: string }>(
			`SELECT json FROM request_payloads WHERE id = ?`,
			[id],
		);

		if (!row) return null;

		// Decryption errors must propagate — they indicate tampering, a wrong key,
		// or a missing key for an encrypted row. Silently returning null would
		// hide real misconfiguration. Only JSON parse errors are tolerated, since
		// historical rows may contain malformed payloads.
		const decoded = await decryptPayload(row.json);
		try {
			return JSON.parse(decoded);
		} catch {
			return null;
		}
	}

	async listPayloads(limit = 50): Promise<Array<{ id: string; json: string }>> {
		const rows = await this.query<{ id: string; json: string }>(
			`
			SELECT rp.id, rp.json
			FROM request_payloads rp
			JOIN requests r ON rp.id = r.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return Promise.all(
			rows.map(async (row) => ({
				id: row.id,
				json: await decryptForList(row.id, row.json),
			})),
		);
	}

	async listPayloadsWithAccountNames(
		limit = 50,
	): Promise<Array<{ id: string; json: string; account_name: string | null }>> {
		const rows = await this.query<{
			id: string;
			json: string;
			account_name: string | null;
		}>(
			`
			SELECT rp.id, rp.json, a.name as account_name
			FROM request_payloads rp
			JOIN requests r ON rp.id = r.id
			LEFT JOIN accounts a ON r.account_used = a.id
			ORDER BY r.timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return Promise.all(
			rows.map(async (row) => ({
				id: row.id,
				json: await decryptForList(row.id, row.json),
				account_name: row.account_name,
			})),
		);
	}

	// Analytics queries
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
		const rows = await this.query<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			status_code: number | null;
			success: 0 | 1;
			response_time_ms: number | null;
		}>(
			`
			SELECT id, timestamp, method, path, account_used, status_code, success, response_time_ms
			FROM requests
			ORDER BY timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return rows.map((row) => ({
			...row,
			success: !!row.success,
		}));
	}

	async getRequestStats(since?: number): Promise<{
		totalRequests: number;
		successfulRequests: number;
		failedRequests: number;
		avgResponseTime: number | null;
	}> {
		const whereClause = since ? "WHERE timestamp > ?" : "";
		const params = since ? [since] : [];

		const result = await this.get<{
			total_requests: number;
			successful_requests: number;
			failed_requests: number;
			avg_response_time: number | null;
		}>(
			`
			SELECT
				COUNT(*) as total_requests,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful_requests,
				SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) as failed_requests,
				AVG(response_time_ms) as avg_response_time
			FROM requests
			${whereClause}
		`,
			params,
		);

		return {
			totalRequests: result?.total_requests || 0,
			successfulRequests: result?.successful_requests || 0,
			failedRequests: result?.failed_requests || 0,
			avgResponseTime: result?.avg_response_time || null,
		};
	}

	/**
	 * Aggregate statistics with optional time range
	 * Consolidates duplicate SQL queries from stats handlers
	 */
	async aggregateStats(rangeMs?: number): Promise<{
		totalRequests: number;
		successfulRequests: number;
		avgResponseTime: number | null;
		totalTokens: number;
		totalCostUsd: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		avgTokensPerSecond: number | null;
	}> {
		const whereClause = rangeMs ? "WHERE timestamp > ?" : "";
		const params = rangeMs ? [Date.now() - rangeMs] : [];

		const result = await this.get<{
			total_requests: number;
			successful_requests: number;
			avg_response_time: number | null;
			total_tokens: number | null;
			total_cost_usd: number | null;
			input_tokens: number | null;
			output_tokens: number | null;
			cache_read_input_tokens: number | null;
			cache_creation_input_tokens: number | null;
			avg_tokens_per_second: number | null;
		}>(
			`
			SELECT
				COUNT(*) as total_requests,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful_requests,
				AVG(response_time_ms) as avg_response_time,
				SUM(total_tokens) as total_tokens,
				SUM(cost_usd) as total_cost_usd,
				SUM(input_tokens) as input_tokens,
				SUM(output_tokens) as output_tokens,
				SUM(cache_read_input_tokens) as cache_read_input_tokens,
				SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
				AVG(output_tokens_per_second) as avg_tokens_per_second
			FROM requests
			${whereClause}
		`,
			params,
		);

		return {
			totalRequests: result?.total_requests || 0,
			successfulRequests: result?.successful_requests || 0,
			avgResponseTime: result?.avg_response_time || null,
			totalTokens: result?.total_tokens || 0,
			totalCostUsd: result?.total_cost_usd || 0,
			inputTokens: result?.input_tokens || 0,
			outputTokens: result?.output_tokens || 0,
			cacheReadInputTokens: result?.cache_read_input_tokens || 0,
			cacheCreationInputTokens: result?.cache_creation_input_tokens || 0,
			avgTokensPerSecond: result?.avg_tokens_per_second || null,
		};
	}

	/**
	 * Get top models by usage
	 */
	async getTopModels(
		limit = 10,
	): Promise<Array<{ model: string; count: number }>> {
		return this.query<{ model: string; count: number }>(
			`
			SELECT model, COUNT(*) as count
			FROM requests
			WHERE model IS NOT NULL
			GROUP BY model
			ORDER BY count DESC
			LIMIT ?
		`,
			[limit],
		);
	}

	/**
	 * Get recent error messages
	 */
	async getRecentErrors(limit = 10): Promise<string[]> {
		const errors = await this.query<{ error_message: string }>(
			`
			SELECT error_message
			FROM requests
			WHERE success = FALSE AND error_message IS NOT NULL
			ORDER BY timestamp DESC
			LIMIT ?
		`,
			[limit],
		);
		return errors.map((e: { error_message: string }) => e.error_message);
	}

	async getRequestsByAccount(since?: number): Promise<
		Array<{
			accountId: string;
			accountName: string | null;
			requestCount: number;
			successRate: number;
		}>
	> {
		const whereClause = since ? "WHERE r.timestamp > ?" : "";
		const params = since ? [since] : [];

		const rows = await this.query<{
			account_id: string;
			account_name: string | null;
			request_count: number;
			success_rate: number;
		}>(
			`
			SELECT
				r.account_used as account_id,
				a.name as account_name,
				COUNT(*) as request_count,
				SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate
			FROM requests r
			LEFT JOIN accounts a ON r.account_used = a.id
			${whereClause}
			GROUP BY r.account_used
			ORDER BY request_count DESC
		`,
			params,
		);
		return rows.map((row) => ({
			accountId: row.account_id,
			accountName: row.account_name,
			requestCount: row.request_count,
			successRate: row.success_rate,
		}));
	}

	async deleteOlderThan(cutoffTs: number): Promise<number> {
		const BATCH_SIZE = 500;
		let total = 0;
		let deleted: number;
		do {
			deleted = await this.runWithChanges(
				`DELETE FROM requests WHERE id IN (
					SELECT id FROM requests WHERE timestamp < ? LIMIT ?
				)`,
				[cutoffTs, BATCH_SIZE],
			);
			total += deleted;
		} while (deleted === BATCH_SIZE);
		return total;
	}

	async deleteOrphanedPayloads(): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM request_payloads WHERE id NOT IN (SELECT id FROM requests)`,
		);
	}

	async deletePayloadsOlderThan(cutoffTs: number): Promise<number> {
		const BATCH_SIZE = 500;
		let total = 0;
		let deleted: number;
		do {
			// Direct timestamp-based deletion — avoids expensive subquery through requests table
			deleted = await this.runWithChanges(
				`DELETE FROM request_payloads WHERE id IN (
					SELECT id FROM request_payloads WHERE timestamp IS NOT NULL AND timestamp < ? LIMIT ?
				)`,
				[cutoffTs, BATCH_SIZE],
			);
			total += deleted;
		} while (deleted === BATCH_SIZE);
		return total;
	}
}
