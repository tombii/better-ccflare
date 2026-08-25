import { sseResponse } from "@better-ccflare/http-common";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler() {
	return (req: Request): Response => {
		let handleLogEvent: ((event: LogEvent) => void) | null = null;
		let isClosed = false;

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				handleLogEvent = (event: LogEvent) => {
					if (isClosed) return;

					try {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
						);
					} catch (_error) {
						// Stream is closed or errored
						isClosed = true;
						if (handleLogEvent) {
							logBus.off("log", handleLogEvent);
							handleLogEvent = null;
						}
					}
				};

				// Send initial connection message
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ connected: true })}\n\n`),
				);

				// Subscribe to log events
				logBus.on("log", handleLogEvent);
			},
			cancel() {
				// Cleanup only this specific listener
				isClosed = true;
				if (handleLogEvent) {
					logBus.off("log", handleLogEvent);
					handleLogEvent = null;
				}
			},
		});

		// Clean up on abort signal
		req.signal?.addEventListener("abort", () => {
			if (!isClosed) {
				isClosed = true;
				if (handleLogEvent) {
					logBus.off("log", handleLogEvent);
					handleLogEvent = null;
				}
			}
		});

		return sseResponse(stream);
	};
}
