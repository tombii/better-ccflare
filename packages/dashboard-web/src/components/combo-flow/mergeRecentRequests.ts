import type { ComboFlowRecentRequest, RequestSummary } from "../../api";

/** Rows shown per combo in the "Recent requests" tab (matches the server cap). */
export const COMBO_FLOW_RECENT_LIMIT = 15;

function fromLive(summary: RequestSummary): ComboFlowRecentRequest {
	return {
		id: summary.id,
		timestamp: new Date(summary.timestamp).getTime(),
		originalModel: summary.originalModel ?? null,
		appliedModel: summary.appliedModel ?? null,
		servedModel: summary.model ?? null,
		account: summary.accountUsed,
		statusCode: summary.statusCode,
		success: summary.success,
		failoverAttempts: summary.failoverAttempts,
		responseTimeMs: summary.responseTimeMs,
	};
}

/**
 * Combines the combo's server-seeded recent rows with the rows the shared
 * request stream has delivered since mount.
 *
 * The server seeds history (newest 15 tagged rows at request time) and live
 * SSE rows cover everything that finishes while the page is open. Dedupe by
 * id with the LIVE row winning: an SSE update can carry fields the summary
 * query did not, and the stream is the fresher of the two. Newest first, then
 * capped — the stream prepends, so its rows are never crowded out by older
 * server rows.
 */
export function mergeRecentRequests(
	serverRows: ComboFlowRecentRequest[],
	liveRows: RequestSummary[],
	comboName: string,
	limit = COMBO_FLOW_RECENT_LIMIT,
): ComboFlowRecentRequest[] {
	const byId = new Map<string, ComboFlowRecentRequest>();
	for (const row of serverRows) byId.set(row.id, row);
	for (const summary of liveRows) {
		if (summary.comboName !== comboName) continue;
		byId.set(summary.id, fromLive(summary));
	}
	return [...byId.values()]
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, limit);
}
