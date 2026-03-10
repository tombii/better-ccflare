import type { Config } from "@better-ccflare/config";
import type { BunSqlAdapter } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import type { HealthResponse } from "../types";

/**
 * Create a health check handler
 */
export function createHealthHandler(db: BunSqlAdapter, config: Config) {
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

		return jsonResponse(response);
	};
}
