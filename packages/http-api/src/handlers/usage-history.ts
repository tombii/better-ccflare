// packages/http-api/src/handlers/usage-history.ts
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type {
	PredictionPoint,
	UsageHistoryResponse,
	UsageHistoryWindowSeries,
} from "@better-ccflare/types";
import { computeUsagePrediction } from "../services/usage-prediction";
import type { APIContext } from "../types";
import { getRangeConfig } from "../utils/query-filters";

const log = new Logger("UsageHistoryHandler");

export function createUsageHistoryHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const accountId = searchParams.get("account");
		if (!accountId) {
			return errorResponse(
				BadRequest("Missing required 'account' query parameter"),
			);
		}
		// getRangeConfig returns the normalized effective `range` (unknown values
		// fall back to 24h) — echo that in the response so it matches startMs.
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		const windowKey = searchParams.get("window") ?? undefined;

		try {
			const rows = await context.dbOps.getUsageHistory({
				accountId,
				windowKey,
				since: startMs,
			});

			const byWindow = new Map<string, PredictionPoint[]>();
			for (const r of rows) {
				const arr = byWindow.get(r.windowKey) ?? [];
				arr.push({
					t: r.timestamp,
					utilization: r.utilization,
					resetsAt: r.resetsAt,
				});
				byWindow.set(r.windowKey, arr);
			}

			const windows: UsageHistoryWindowSeries[] = [...byWindow.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([window, points]) => ({
					window,
					points,
					prediction: computeUsagePrediction(points),
				}));

			const response: UsageHistoryResponse = { accountId, range, windows };
			return jsonResponse(response);
		} catch (error) {
			log.error("Usage history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch usage history"),
			);
		}
	};
}
