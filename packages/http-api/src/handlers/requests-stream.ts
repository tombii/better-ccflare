import { type RequestEvt, requestEvents } from "@ccflare/core";

export function createRequestsStreamHandler() {
	return (): Response => {
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();

				// Helper to send SSE formatted data
				const write = (data: RequestEvt) => {
					const message = `data: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(message));
				};

				// Send initial connection message
				const connectMsg = `event: connected\ndata: ok\n\n`;
				controller.enqueue(encoder.encode(connectMsg));

				// Listen for events
				requestEvents.on("event", write);
			},
			cancel() {
				// Cleanup on stream cancellation
				requestEvents.removeAllListeners("event");
			},
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
