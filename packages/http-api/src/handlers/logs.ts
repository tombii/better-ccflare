import { sseResponse } from "@better-ccflare/http-common";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { SSE_KEEPALIVE_INTERVAL_MS, startSseKeepalive } from "./sse-keepalive";

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler(
	keepaliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS,
) {
	return (req: Request): Response => {
		let handleLogEvent: ((event: LogEvent) => void) | null = null;
		let isClosed = false;
		let stopKeepalive: () => void = () => {};

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
						stopKeepalive();
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

				stopKeepalive = startSseKeepalive(
					controller,
					keepaliveIntervalMs,
					() => {
						isClosed = true;
						if (handleLogEvent) {
							logBus.off("log", handleLogEvent);
							handleLogEvent = null;
						}
					},
				);
			},
			cancel() {
				// Cleanup only this specific listener
				isClosed = true;
				stopKeepalive();
				if (handleLogEvent) {
					logBus.off("log", handleLogEvent);
					handleLogEvent = null;
				}
			},
		});

		// Clean up on abort signal
		req.signal?.addEventListener("abort", () => {
			stopKeepalive();
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
