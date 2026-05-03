import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";

export function createStorageHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const metrics = await dbOps.getStorageMetrics();
		const integrity = dbOps.getIntegrityStatus();

		const response = {
			db_bytes: metrics.dbBytes,
			wal_bytes: metrics.walBytes,
			integrity_status: integrity.status,
			last_integrity_check_at: integrity.lastCheckAt
				? new Date(integrity.lastCheckAt).toISOString()
				: null,
			orphan_pages: metrics.orphanPages,
			last_retention_sweep_at: metrics.lastRetentionSweepAt
				? new Date(metrics.lastRetentionSweepAt).toISOString()
				: null,
			null_account_rows_24h: metrics.nullAccountRows,
		};

		return jsonResponse(response);
	};
}
