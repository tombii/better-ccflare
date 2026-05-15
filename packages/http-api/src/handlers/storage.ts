import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import { runIntegrityCheckOnDemand } from "@better-ccflare/proxy";

export function createStorageHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const metrics = await dbOps.getStorageMetrics();
		const integrity = dbOps.getIntegrityStatus();

		const response = {
			db_bytes: metrics.dbBytes,
			wal_bytes: metrics.walBytes,
			integrity_status: integrity.status,
			integrity_running_kind: integrity.runningKind,
			last_integrity_check_at: integrity.lastCheckAt
				? new Date(integrity.lastCheckAt).toISOString()
				: null,
			last_integrity_error: integrity.lastError,
			last_quick_check_at: integrity.lastQuickCheckAt
				? new Date(integrity.lastQuickCheckAt).toISOString()
				: null,
			last_quick_result: integrity.lastQuickResult,
			last_full_check_at: integrity.lastFullCheckAt
				? new Date(integrity.lastFullCheckAt).toISOString()
				: null,
			last_full_result: integrity.lastFullResult,
			orphan_pages: metrics.orphanPages,
			last_retention_sweep_at: metrics.lastRetentionSweepAt
				? new Date(metrics.lastRetentionSweepAt).toISOString()
				: null,
			null_account_rows_24h: metrics.nullAccountRows,
		};

		return jsonResponse(response);
	};
}

/**
 * On-demand integrity check trigger. Body: `{ kind: "quick" | "full" }`.
 *
 *  - **quick** runs synchronously on the main thread (it's a fast pragma).
 *    Returns 200 with `{result, error}` once the check finishes.
 *  - **full** spawns the integrity-check worker so the proxy event loop
 *    isn't blocked for tens of seconds. The request awaits the worker —
 *    the HTTP client therefore sees the result inline, but other requests
 *    keep flowing. If the call is initiated while another check is already
 *    running, returns 409.
 *
 * Sits behind the existing `/api/*` API-key auth middleware. The
 * scheduler-tracked status visible at `/api/storage` and `/health` reflects
 * the result identically whether triggered by the scheduler or this route.
 */
export function createIntegrityCheckHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		let body: { kind?: unknown } = {};
		try {
			body = (await req.json()) as { kind?: unknown };
		} catch {
			// Empty body / non-JSON is fine — default below
		}
		const kind = body.kind === "full" ? "full" : "quick";

		const outcome = await runIntegrityCheckOnDemand(dbOps, kind);
		if (!outcome.ok) {
			return jsonResponse(
				{
					error: "integrity check already running",
					reason: outcome.reason,
				},
				409,
			);
		}

		return jsonResponse({
			kind,
			result: outcome.result,
			error: outcome.error,
		});
	};
}
