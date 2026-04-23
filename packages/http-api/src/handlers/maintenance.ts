import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import type { CleanupResponse, CompactResponse } from "../types";

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
		await dbOps.compact();
		const cutoffIso = new Date(
			Date.now() - Math.min(payloadMs, requestMs),
		).toISOString();
		const payload: CleanupResponse = {
			removedRequests,
			removedPayloads,
			cutoffIso,
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
			...(result.error ? { error: result.error } : {}),
		};
		return jsonResponse(payload);
	};
}
