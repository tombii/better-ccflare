import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@claudeflare/http-common";
import { logFileWriter } from "@claudeflare/logger";

/**
 * Create a logs history handler to fetch past logs
 */
export function createLogsHistoryHandler() {
	return async (): Promise<Response> => {
		try {
			// Get the last 1000 logs by default
			const logs = await logFileWriter.readLogs(1000);

			return jsonResponse(logs);
		} catch (_error) {
			return errorResponse(InternalServerError("Failed to fetch log history"));
		}
	};
}
