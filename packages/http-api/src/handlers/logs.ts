import { logBus } from "@claudeflare/logger";
import type { LogEvent } from "@claudeflare/core";

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler() {
	return (): Response => {
		const stream = new ReadableStream({
			start(controller) {
				// Send initial connection message
				controller.enqueue(`data: ${JSON.stringify({ connected: true })}\n\n`);

				// Listen for log events
				const listener = (event: LogEvent) => {
					const data = `data: ${JSON.stringify(event)}\n\n`;
					controller.enqueue(data);
				};

				logBus.on("log", listener);

				// Clean up on close
				const cleanup = () => {
					logBus.off("log", listener);
				};

				// Handle client disconnect
				return cleanup;
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	};
}
