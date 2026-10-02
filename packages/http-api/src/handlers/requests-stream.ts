import { type RequestEvt, requestEvents } from "@better-ccflare/core";
import { SSE_KEEPALIVE_INTERVAL_MS, startSseKeepalive } from "./sse-keepalive";

export function createRequestsStreamHandler(
	keepaliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS,
) {
	return (req: Request): Response => {
		// Store the write handler outside to access it in cancel
		let writeHandler: ((data: RequestEvt) => void) | null = null;
		let isClosed = false;
		let stopKeepalive: () => void = () => {};

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				// Helper to send SSE formatted data with error handling
				writeHandler = (data: RequestEvt) => {
					if (isClosed) return;

					try {
						const message = `data: ${JSON.stringify(data)}\n\n`;
						controller.enqueue(encoder.encode(message));
					} catch (_error) {
						// Stream is closed or errored
						isClosed = true;
						stopKeepalive();
						if (writeHandler) {
							requestEvents.off("event", writeHandler);
							writeHandler = null;
						}
					}
				};

				// Send initial connection message
				const connectMsg = `event: connected\ndata: ok\n\n`;
				controller.enqueue(encoder.encode(connectMsg));

				// Listen for events
				requestEvents.on("event", writeHandler);

				stopKeepalive = startSseKeepalive(
					controller,
					keepaliveIntervalMs,
					() => {
						isClosed = true;
						if (writeHandler) {
							requestEvents.off("event", writeHandler);
							writeHandler = null;
						}
					},
				);
			},
			cancel() {
				// Cleanup only this specific listener
				isClosed = true;
				stopKeepalive();
				if (writeHandler) {
					requestEvents.off("event", writeHandler);
					writeHandler = null;
				}
			},
		});

		// Clean up on abort signal
		req.signal?.addEventListener("abort", () => {
			stopKeepalive();
			if (!isClosed) {
				isClosed = true;
				if (writeHandler) {
					requestEvents.off("event", writeHandler);
					writeHandler = null;
				}
			}
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				Connection: "keep-alive",
				"Cache-Control": "no-cache",
			},
		});
	};
}
