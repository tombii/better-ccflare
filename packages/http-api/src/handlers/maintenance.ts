import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import { jsonResponse } from "@ccflare/http-common";
import type { CleanupResponse } from "../types";

export function createCleanupHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return (): Response => {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const payloadMs = payloadDays * 24 * 60 * 60 * 1000;
		const requestMs = requestDays * 24 * 60 * 60 * 1000;
		const { removedRequests, removedPayloads } = dbOps.cleanupOldRequests(
			payloadMs,
			requestMs,
		);
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
	return (): Response => {
		dbOps.compact();
		return jsonResponse({ ok: true });
	};
}
