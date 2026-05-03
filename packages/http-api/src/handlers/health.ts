import type { Config } from "@better-ccflare/config";
import type { BunSqlAdapter } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import type { HealthResponse, IntegrityStatus } from "../types";

type AsyncWriterHealthFn = () => {
	healthy: boolean;
	failureCount: number;
	queuedJobs: number;
};
type UsageWorkerHealthFn = () => {
	state: string;
	pendingAcks: number;
	lastError: string | null;
	startedAt: number | null;
};
type IntegrityStatusFn = () => IntegrityStatus;

export function createHealthHandler(
	db: BunSqlAdapter,
	config: Config,
	getAsyncWriterHealth?: AsyncWriterHealthFn,
	getUsageWorkerHealth?: UsageWorkerHealthFn,
	getIntegrityStatus?: IntegrityStatusFn,
) {
	return async (): Promise<Response> => {
		const accountCount = await db.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM accounts",
		);

		const routableCount = await db.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM accounts WHERE paused = 0 AND (rate_limited_until IS NULL OR rate_limited_until <= ?)",
			[Date.now()],
		);

		const status = (routableCount?.count ?? 0) > 0 ? "ok" : "degraded";

		const response: HealthResponse = {
			status,
			accounts: accountCount?.count || 0,
			timestamp: new Date().toISOString(),
			strategy: config.getStrategy(),
		};

		// Build runtime section if any runtime health functions are provided
		if (getAsyncWriterHealth && getUsageWorkerHealth) {
			response.runtime = {
				asyncWriter: getAsyncWriterHealth(),
				usageWorker: getUsageWorkerHealth(),
			};
		}

		// Add storage integrity independently — orthogonal to asyncWriter/usageWorker
		if (getIntegrityStatus) {
			if (!response.runtime) {
				response.runtime = {};
			}
			const integrity = getIntegrityStatus();
			response.runtime!.storage = {
				integrity: {
					status: integrity.status,
					lastCheckAt: integrity.lastCheckAt
						? new Date(integrity.lastCheckAt).toISOString()
						: null,
					lastError: integrity.lastError,
				},
			};
		}

		return jsonResponse(response);
	};
}
