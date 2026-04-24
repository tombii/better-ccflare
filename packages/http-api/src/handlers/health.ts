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

export function createHealthHandler(
	db: BunSqlAdapter,
	config: Config,
	getAsyncWriterHealth?: AsyncWriterHealthFn,
	getUsageWorkerHealth?: UsageWorkerHealthFn,
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

		if (getAsyncWriterHealth && getUsageWorkerHealth) {
			response.runtime = {
				asyncWriter: getAsyncWriterHealth(),
				usageWorker: getUsageWorkerHealth(),
			};
		}

		return jsonResponse(response);
	};
}
