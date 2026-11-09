import type { ComboFlowRecentRequest, RequestSummary } from "../../api";

/** Rows shown per combo in the "Recent requests" tab (matches the server cap). */
export const COMBO_FLOW_RECENT_LIMIT = 15;

function fromLive(
	summary: RequestSummary,
	accountNameById?: ReadonlyMap<string, string>,
): ComboFlowRecentRequest {
	return {
		id: summary.id,
		timestamp: new Date(summary.timestamp).getTime(),
		originalModel: summary.originalModel ?? null,
		appliedModel: summary.appliedModel ?? null,
		servedModel: summary.model ?? null,
		// The SSE summary carries `accountUsed` as the account ID
		// (usage-collector sets it from startMessage.accountId), while the
		// server-seeded rows carry the resolved name. Without this lookup a
		// just-finished request would overwrite the good name with an ID.
		account: summary.accountUsed
			? (accountNameById?.get(summary.accountUsed) ?? summary.accountUsed)
			: null,
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
	/** id → display name, so live rows match the server rows' account labels. */
	accountNameById?: ReadonlyMap<string, string>,
): ComboFlowRecentRequest[] {
	const byId = new Map<string, ComboFlowRecentRequest>();
	for (const row of serverRows) byId.set(row.id, row);
	for (const summary of liveRows) {
		if (summary.comboName !== comboName) continue;
		byId.set(summary.id, fromLive(summary, accountNameById));
	}
	return [...byId.values()]
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, limit);
}
