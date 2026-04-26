import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import type { CleanupResponse, CompactResponse } from "../types";

export function createCleanupHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (): Promise<Response> => {
		const requestDays = config.getRequestRetentionDays();
		const requestMs = requestDays * 24 * 60 * 60 * 1000;
		// When payload storage is disabled, delete all existing payloads (cutoff = now).
		// When enabled, honour the configured retention window.
		const payloadMs = config.getStorePayloads()
			? config.getDataRetentionDays() * 24 * 60 * 60 * 1000
			: 0;
		const { removedRequests, removedPayloads } = await dbOps.cleanupOldRequests(
			payloadMs,
			requestMs,
		);
		const [tableRowCounts, dbSizeBytes] = await Promise.all([
			dbOps.getTableRowCounts(),
			dbOps.getDbSizeBytes(),
		]);
		const now = Date.now();
		const payload: CleanupResponse = {
			removedRequests,
			removedPayloads,
			payloadCutoffIso: new Date(now - payloadMs).toISOString(),
			requestCutoffIso: new Date(now - requestMs).toISOString(),
			dbSizeBytes,
			tableRowCounts,
		};
		return jsonResponse(payload);
	};
}

export function createCompactHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const result = await dbOps.compact();
		const payload: CompactResponse = {
			ok: result.vacuumed && !result.error,
			walBusy: result.walBusy,
			walLog: result.walLog,
			walCheckpointed: result.walCheckpointed,
			vacuumed: result.vacuumed,
			...(result.walTruncateBusy !== undefined
				? { walTruncateBusy: result.walTruncateBusy }
				: {}),
			...(result.error ? { error: result.error } : {}),
		};
		return jsonResponse(payload);
	};
}
