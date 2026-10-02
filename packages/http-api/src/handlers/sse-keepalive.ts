export const SSE_KEEPALIVE_INTERVAL_MS = 20_000;

const PING = new TextEncoder().encode(": ping\n\n");

/**
 * Sends an SSE comment ping on an interval so idle streams are not closed by
 * the server or intermediaries. Returns a stop function; the timer also stops
 * itself (and calls `onFail`) when the enqueue throws.
 */
export function startSseKeepalive(
	controller: ReadableStreamDefaultController<Uint8Array>,
	intervalMs: number,
	onFail: () => void,
): () => void {
	const timer = setInterval(() => {
		try {
			controller.enqueue(PING);
		} catch (_error) {
			clearInterval(timer);
			onFail();
		}
	}, intervalMs);
	return () => clearInterval(timer);
}
