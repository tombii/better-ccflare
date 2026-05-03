import type { Config } from "@better-ccflare/config";
import type { BunSqlAdapter } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import type { HealthResponse } from "../types";

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
type IntegrityStatusFn = () => {
	status: "ok" | "corrupt" | "unchecked";
	lastCheckAt: number | null;
	lastError: string | null;
};

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

		const response: HealthResponse = {
			status: "ok",
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

			// Add storage integrity if provided
			if (getIntegrityStatus) {
				const integrity = getIntegrityStatus();
				response.runtime.storage = {
					integrity: {
						status: integrity.status,
						lastCheckAt: integrity.lastCheckAt
							? new Date(integrity.lastCheckAt).toISOString()
							: null,
						lastError: integrity.lastError,
					},
				};
			}
		}

		return jsonResponse(response);
	};
}
