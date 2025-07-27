import type { LogEvent } from "@claudeflare/core";
import { logBus } from "@claudeflare/logger";

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
