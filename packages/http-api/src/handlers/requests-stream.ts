import { type RequestEvt, requestEvents } from "@better-ccflare/core";

export function createRequestsStreamHandler() {
	return (req: Request): Response => {
		// Store the write handler outside to access it in cancel
		let writeHandler: ((data: RequestEvt) => void) | null = null;
		let isClosed = false;

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
			},
			cancel() {
				// Cleanup only this specific listener
				isClosed = true;
				if (writeHandler) {
					requestEvents.off("event", writeHandler);
					writeHandler = null;
				}
			},
		});

		// Clean up on abort signal
		req.signal?.addEventListener("abort", () => {
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
