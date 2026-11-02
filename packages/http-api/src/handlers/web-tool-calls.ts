import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	WEB_TOOL_CALL_STATUSES,
	type WebToolCall,
	type WebToolCallStatus,
	type WebToolCallSummary,
} from "@better-ccflare/types";

const log = new Logger("WebToolCallsHandler");

/**
 * Read-only dependency surface for the `web_tool_calls` trace. The database
 * layer's `DatabaseOperations` already satisfies this shape; tests substitute
 * a fake.
 */
export interface WebToolCallStore {
	listWebToolCalls(
		limit: number,
		filters?: {
			status?: WebToolCallStatus;
			providerKind?: string;
			since?: number;
		},
	): Promise<WebToolCall[]>;
	webToolCallSummary(since: number): Promise<WebToolCallSummary[]>;
}

export interface WebToolCallHandlers {
	list(searchParams: URLSearchParams): Promise<Response>;
	summary(searchParams: URLSearchParams): Promise<Response>;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_SUMMARY_HOURS = 24;
export const MAX_SUMMARY_HOURS = 8760;

/** `limit` clamped to 1..200; absent, non-numeric or <1 → 50. */
export function parseLimit(raw: string | null): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIST_LIMIT;
	return Math.min(parsed, MAX_LIST_LIMIT);
}

/** `hours` clamped to 1..8760; absent, non-numeric or <1 → 24. */
export function parseHours(raw: string | null): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SUMMARY_HOURS;
	return Math.min(parsed, MAX_SUMMARY_HOURS);
}

function isStatus(raw: string): raw is WebToolCallStatus {
	return (WEB_TOOL_CALL_STATUSES as readonly string[]).includes(raw);
}

/**
 * `since` as epoch ms. Accepts epoch milliseconds, epoch seconds (below 1e12)
 * or an ISO-8601 date. Returns `undefined` when absent and `null` when
 * malformed, so the caller can answer 400 instead of silently ignoring it.
 */
export function parseSince(raw: string | null): number | undefined | null {
	if (raw === null || raw.trim() === "") return undefined;
	const trimmed = raw.trim();
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && numeric > 0) {
		return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
	}
	const parsedDate = Date.parse(trimmed);
	return Number.isFinite(parsedDate) ? parsedDate : null;
}

export function createWebToolCallHandlers(
	store: WebToolCallStore,
	now: () => number = Date.now,
): WebToolCallHandlers {
	return {
		list: async (searchParams: URLSearchParams): Promise<Response> => {
			const limit = parseLimit(searchParams.get("limit"));

			const statusRaw = searchParams.get("status");
			if (statusRaw !== null && statusRaw !== "" && !isStatus(statusRaw)) {
				return errorResponse(BadRequest(`Unknown status '${statusRaw}'`));
			}
			const since = parseSince(searchParams.get("since"));
			if (since === null) {
				return errorResponse(
					BadRequest("since must be an epoch time (s or ms) or an ISO date"),
				);
			}
			const providerKindRaw = searchParams.get("providerKind");

			try {
				const data = await store.listWebToolCalls(limit, {
					status: statusRaw ? (statusRaw as WebToolCallStatus) : undefined,
					providerKind:
						providerKindRaw && providerKindRaw.trim() !== ""
							? providerKindRaw.trim()
							: undefined,
					since,
				});
				return jsonResponse({ success: true, data, count: data.length });
			} catch (error) {
				log.error("Web tool calls list error:", error);
				return errorResponse(
					InternalServerError("Failed to list web tool calls"),
				);
			}
		},

		summary: async (searchParams: URLSearchParams): Promise<Response> => {
			const hours = parseHours(searchParams.get("hours"));
			try {
				const data = await store.webToolCallSummary(
					now() - hours * 60 * 60 * 1000,
				);
				return jsonResponse({ success: true, data });
			} catch (error) {
				log.error("Web tool call summary error:", error);
				return errorResponse(
					InternalServerError("Failed to summarise web tool calls"),
				);
			}
		},
	};
}
