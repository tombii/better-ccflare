/**
 * Drain a reader to `done`, dropping each chunk. `reader.cancel()` is a
 * no-op on every released Bun (oven-sh/bun#35093) and leaks the upstream's
 * native buffer; draining actually releases it. Errors are swallowed since
 * this is best-effort cleanup, not part of the caller's control flow (#382).
 */
export async function drainReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) return;
		}
	} catch {
		// Swallow — draining must not throw during cleanup.
	} finally {
		reader.releaseLock();
	}
}
