import type { Database } from "bun:sqlite";
import type { Config } from "@better-ccflare/config";
import { jsonResponse } from "@better-ccflare/http-common";
import type { HealthResponse } from "../types";

/**
 * Create a health check handler
 */
export function createHealthHandler(db: Database, config: Config) {
	return (): Response => {
		const accountCount = db
			.query("SELECT COUNT(*) as count FROM accounts")
			.get() as { count: number } | undefined;

		const response: HealthResponse = {
			status: "ok",
			accounts: accountCount?.count || 0,
			timestamp: new Date().toISOString(),
			strategy: config.getStrategy(),
		};

		return jsonResponse(response);
	};
}
