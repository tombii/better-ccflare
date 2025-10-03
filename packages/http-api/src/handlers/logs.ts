import { sseResponse } from "@better-ccflare/http-common";
import { Logger, logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";

const log = new Logger("LogsHandler");

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler() {
	return (req: Request): Response => {
		// Use TransformStream for better Bun compatibility
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		let closed = false;
		let handleLogEvent: ((event: LogEvent) => Promise<void>) | null = null;

		// Send initial connection message
		(async () => {
			try {
				const initialData = `data: ${JSON.stringify({ connected: true })}\n\n`;
				await writer.write(encoder.encode(initialData));
			} catch (e) {
				log.error("Error sending initial message:", e);
			}
		})();

		// Listen for log events
		handleLogEvent = async (event: LogEvent) => {
			if (closed) return;

			try {
				const data = `data: ${JSON.stringify(event)}\n\n`;
				await writer.write(encoder.encode(data));
			} catch (_error) {
				// Stream closed
				closed = true;
				if (handleLogEvent) {
					logBus.off("log", handleLogEvent);
					handleLogEvent = null;
				}
				try {
					await writer.close();
				} catch {}
			}
		};

		// Subscribe to log events
		logBus.on("log", handleLogEvent);

		// Clean up on abort signal
		req.signal?.addEventListener("abort", () => {
			if (!closed) {
				closed = true;
				if (handleLogEvent) {
					logBus.off("log", handleLogEvent);
					handleLogEvent = null;
				}
				try {
					writer.close();
				} catch {}
			}
		});

		return sseResponse(readable);
	};
}
