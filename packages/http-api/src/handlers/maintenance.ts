import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { CleanupResponse, CompactResponse } from "../types";

const log = new Logger("MaintenanceHandler");

export function createCleanupHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (): Promise<Response> => {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const payloadMs = payloadDays * 24 * 60 * 60 * 1000;
		const requestMs = requestDays * 24 * 60 * 60 * 1000;
		const { removedRequests, removedPayloads } = await dbOps.cleanupOldRequests(
			payloadMs,
			requestMs,
		);
		const compactResult = await dbOps.compact();
		if (compactResult.error || !compactResult.vacuumed) {
			log.warn("Database compaction did not complete cleanly", {
				vacuumed: compactResult.vacuumed,
				error: compactResult.error,
				walBusy: compactResult.walBusy,
				walLog: compactResult.walLog,
				walCheckpointed: compactResult.walCheckpointed,
			});
		} else {
			log.info("Database compaction completed", {
				walBusy: compactResult.walBusy,
				walLog: compactResult.walLog,
				walCheckpointed: compactResult.walCheckpointed,
				vacuumed: compactResult.vacuumed,
			});
		}
		const now = Date.now();
		const payload: CleanupResponse = {
			removedRequests,
			removedPayloads,
			payloadCutoffIso: new Date(now - payloadMs).toISOString(),
			requestCutoffIso: new Date(now - requestMs).toISOString(),
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
