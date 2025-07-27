import { logBus } from "@claudeflare/logger";
import type { LogEvent } from "@claudeflare/core";

/**
 * Create a logs stream handler using Server-Sent Events
 */
export function createLogsStreamHandler() {
	return (): Response => {
		// Use TransformStream for better Bun compatibility
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		let closed = false;

		// Send initial connection message
		(async () => {
			try {
				const initialData = `data: ${JSON.stringify({ connected: true })}\n\n`;
				await writer.write(encoder.encode(initialData));
			} catch (e) {
				console.error("Error sending initial message:", e);
			}
		})();

		// Listen for log events
		const handleLogEvent = async (event: LogEvent) => {
			if (closed) return;

			try {
				const data = `data: ${JSON.stringify(event)}\n\n`;
				await writer.write(encoder.encode(data));
			} catch (error) {
				// Stream closed
				closed = true;
				logBus.off("log", handleLogEvent);
				try {
					await writer.close();
				} catch {}
			}
		};

		// Subscribe to log events
		logBus.on("log", handleLogEvent);

		// Clean up on request abort
		setTimeout(() => {
			if (
				!closed &&
				typeof (readable as any).closed !== "undefined" &&
				(readable as any).closed
			) {
				closed = true;
				logBus.off("log", handleLogEvent);
				try {
					writer.close();
				} catch {}
			}
		}, 0);

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	};
}
