import type { Database } from "bun:sqlite";
import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import type { RequestResponse } from "../types";

const MAX_BODY_PREVIEW_BYTES = 32 * 1024; // 32KB preview to keep responses lightweight
const MAX_REQUEST_DETAILS_LIMIT = 50;

function truncateBase64(body: unknown): {
	body: string | null;
	truncated: boolean;
} {
	if (!body || typeof body !== "string") {
		return { body: body as string | null, truncated: false };
	}

	try {
		const decoded = Buffer.from(body, "base64");
		if (decoded.length <= MAX_BODY_PREVIEW_BYTES) {
			return { body, truncated: false };
		}

		const sliced = decoded.subarray(0, MAX_BODY_PREVIEW_BYTES);
		return { body: sliced.toString("base64"), truncated: true };
	} catch {
		// If the payload is not valid base64, return null to avoid blowing up the response
		return { body: null, truncated: true };
	}
}

/**
 * Create a requests summary handler (existing functionality)
 */
export function createRequestsSummaryHandler(db: Database) {
	return (limit: number = 50): Response => {
		const requests = db
			.query(
				`
				SELECT r.*, a.name as account_name
				FROM requests r
				LEFT JOIN accounts a ON r.account_used = a.id
				ORDER BY r.timestamp DESC
				LIMIT ?1
			`,
			)
			.all(limit) as Array<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			account_name: string | null;
			status_code: number | null;
			success: 0 | 1;
			error_message: string | null;
			response_time_ms: number | null;
			failover_attempts: number;
			model: string | null;
			prompt_tokens: number | null;
			completion_tokens: number | null;
			total_tokens: number | null;
			input_tokens: number | null;
			cache_read_input_tokens: number | null;
			cache_creation_input_tokens: number | null;
			output_tokens: number | null;
			cost_usd: number | null;
			agent_used: string | null;
			output_tokens_per_second: number | null;
			api_key_id: string | null;
			api_key_name: string | null;
		}>;

		const response: RequestResponse[] = requests.map((request) => ({
			id: request.id,
			timestamp: new Date(request.timestamp).toISOString(),
			method: request.method,
			path: request.path,
			accountUsed: request.account_name || request.account_used,
			statusCode: request.status_code,
			success: request.success === 1,
			errorMessage: request.error_message,
			responseTimeMs: request.response_time_ms,
			failoverAttempts: request.failover_attempts,
			model: request.model || undefined,
			promptTokens: request.prompt_tokens || undefined,
			completionTokens: request.completion_tokens || undefined,
			totalTokens: request.total_tokens || undefined,
			inputTokens: request.input_tokens || undefined,
			cacheReadInputTokens: request.cache_read_input_tokens || undefined,
			cacheCreationInputTokens:
				request.cache_creation_input_tokens || undefined,
			outputTokens: request.output_tokens || undefined,
			costUsd: request.cost_usd || undefined,
			agentUsed: request.agent_used || undefined,
			tokensPerSecond: request.output_tokens_per_second || undefined,
			apiKeyId: request.api_key_id || undefined,
			apiKeyName: request.api_key_name || undefined,
		}));

		return jsonResponse(response);
	};
}

/**
 * Create a detailed requests handler with full payload data
 */
export function createRequestsDetailHandler(dbOps: DatabaseOperations) {
	return (limit = 100): Response => {
		const safeLimit = Math.min(
			Math.max(Number.isFinite(limit) ? limit : 1, 1),
			MAX_REQUEST_DETAILS_LIMIT,
		);
		const rows = dbOps.listRequestPayloadsWithAccountNames(safeLimit);
		const parsed = rows.map((r) => {
			try {
				const data = JSON.parse(r.json) as Record<string, unknown>;

				const request = data.request as
					| { body?: string | null; truncated?: boolean }
					| undefined;
				const response = data.response as
					| { body?: string | null; truncated?: boolean }
					| undefined;
				let meta = data.meta as Record<string, unknown> | undefined;
				if (!meta) {
					meta = {};
				}
				meta.limitApplied = safeLimit;

				if (request?.body) {
					const { body, truncated } = truncateBase64(request.body);
					request.body = body;
					if (truncated) {
						request.truncated = true;
						meta.requestBodyTruncated = true;
					}
				}

				if (response?.body) {
					const { body, truncated } = truncateBase64(response.body);
					response.body = body;
					if (truncated) {
						response.truncated = true;
						meta.responseBodyTruncated = true;
					}
				}

				data.request = request;
				data.response = response;

				if (r.account_name) {
					meta.accountName = r.account_name;
				}
				data.meta = meta;

				return { id: r.id, ...data };
			} catch {
				return { id: r.id, error: "Failed to parse payload" };
			}
		});

		return jsonResponse(parsed);
	};
}

/**
 * Create a handler for lazy loading individual request payloads
 * This endpoint supports the performance optimization that eliminates JSON parsing bottleneck
 */
export function createRequestPayloadHandler(dbOps: DatabaseOperations) {
	return (requestId: string): Response => {
		const payload = dbOps.getRequestPayload(requestId);

		if (!payload) {
			return new Response(JSON.stringify({ error: "Request not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		return jsonResponse(payload);
	};
}
