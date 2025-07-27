import type { LogEvent } from "@claudeflare/types";
import { logBus, logFileWriter } from "@claudeflare/logger";

export function streamLogs(callback: (log: LogEvent) => void): () => void {
	const listener = (event: LogEvent) => {
		callback(event);
	};

	logBus.on("log", listener);

	// Return unsubscribe function
	return () => {
		logBus.off("log", listener);
	};
}

export async function getLogHistory(limit = 1000): Promise<LogEvent[]> {
	try {
		return await logFileWriter.readLogs(limit);
	} catch (error) {
		console.error("Failed to read log history:", error);
		return [];
	}
}
