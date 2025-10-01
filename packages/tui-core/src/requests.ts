import {
	DatabaseFactory,
	withDatabaseRetrySync,
} from "@better-ccflare/database";
import type { RequestPayload } from "@better-ccflare/types";

export type { RequestPayload };

export interface RequestSummary {
	id: string;
	timestamp: number;
	status: number | null;
	accountUsed: string | null;
	accountName: string | null;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	costUsd?: number;
	responseTimeMs?: number;
}

/**
 * Get request summaries without loading full payloads
 * This is the optimized version that eliminates JSON parsing bottleneck
 */
export async function getRequestSummaries(
	limit = 100,
): Promise<Map<string, RequestSummary>> {
	const dbOps = DatabaseFactory.getInstance();
	const db = dbOps.getDatabase();

	const summaries = withDatabaseRetrySync(
		() => {
			return db
				.query(
					`
				SELECT
					r.id,
					r.timestamp,
					r.status_code as status,
					r.account_used as accountUsed,
					a.name as accountName,
					r.model,
					r.input_tokens as inputTokens,
					r.output_tokens as outputTokens,
					r.total_tokens as totalTokens,
					r.cache_read_input_tokens as cacheReadInputTokens,
					r.cache_creation_input_tokens as cacheCreationInputTokens,
					r.cost_usd as costUsd,
					r.response_time_ms as responseTimeMs
				FROM requests r
				LEFT JOIN accounts a ON r.account_used = a.id
				ORDER BY r.timestamp DESC
				LIMIT ?
			`,
				)
				.all(limit) as Array<{
				id: string;
				timestamp: number;
				status: number | null;
				accountUsed: string | null;
				accountName: string | null;
				model?: string;
				inputTokens?: number;
				outputTokens?: number;
				totalTokens?: number;
				cacheReadInputTokens?: number;
				cacheCreationInputTokens?: number;
				costUsd?: number;
				responseTimeMs?: number;
			}>;
		},
		dbOps.getRetryConfig(),
		"getRequestSummaries",
	);

	const summaryMap = new Map<string, RequestSummary>();
	for (const summary of summaries) {
		summaryMap.set(summary.id, {
			id: summary.id,
			timestamp: summary.timestamp,
			status: summary.status,
			accountUsed: summary.accountUsed,
			accountName: summary.accountName,
			model: summary.model || undefined,
			inputTokens: summary.inputTokens || undefined,
			outputTokens: summary.outputTokens || undefined,
			totalTokens: summary.totalTokens || undefined,
			cacheReadInputTokens: summary.cacheReadInputTokens || undefined,
			cacheCreationInputTokens: summary.cacheCreationInputTokens || undefined,
			costUsd: summary.costUsd || undefined,
			responseTimeMs: summary.responseTimeMs || undefined,
		});
	}

	return summaryMap;
}

/**
 * Get a single request payload by ID (lazy loading)
 */
export async function getRequestPayload(
	id: string,
): Promise<RequestPayload | null> {
	const dbOps = DatabaseFactory.getInstance();

	return withDatabaseRetrySync(
		() => {
			const payload = dbOps.getRequestPayload(id);
			if (!payload) {
				return null;
			}

			try {
				return payload as RequestPayload;
			} catch {
				return {
					id,
					error: "Failed to parse payload",
					request: { headers: {}, body: null },
					response: null,
					meta: { timestamp: Date.now() },
				} as RequestPayload;
			}
		},
		dbOps.getRetryConfig(),
		"getRequestPayload",
	);
}

/**
 * Legacy function for backward compatibility - now uses optimized approach
 * @deprecated Use getRequestSummaries() and getRequestPayload() instead
 */
export async function getRequests(limit = 100): Promise<RequestPayload[]> {
	const dbOps = DatabaseFactory.getInstance();
	const rows = dbOps.listRequestPayloads(limit);

	const parsed = rows.map((r: { id: string; json: string }) => {
		try {
			const data = JSON.parse(r.json);
			// Add account name if we have accountId
			if (data.meta?.accountId) {
				const account = dbOps.getAccount(data.meta.accountId);
				if (account) {
					data.meta.accountName = account.name;
				}
			}
			return { id: r.id, ...data } as RequestPayload;
		} catch {
			return {
				id: r.id,
				error: "Failed to parse payload",
				request: { headers: {}, body: null },
				response: null,
				meta: { timestamp: Date.now() },
			} as RequestPayload;
		}
	});

	return parsed;
}
