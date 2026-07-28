/**
 * Best-effort drain of a discarded response body to release off-heap backing
 * storage (issue #273 — Bun's fetch leaks native body per abandoned
 * `Response`; the upstream fix oven-sh/bun#35093 is not yet shipped).
 *
 * We drain the body in chunks rather than calling `body.cancel()`, because
 * `body.cancel()` is a NO-OP on every released Bun (Bun 1.3.2, 1.3.14, and
 * earlier): ccflare-42 measured 78–83 KB/req leak with `cancel()`,
 * indistinguishable from no cancel at all. Draining the body (reading it to
 * `done` in chunks) actually closes the upstream source and frees the
 * backing store — measured at ~85% reduction in RSS growth on stock Bun
 * 1.3.14.
 *
 * Why chunked drain and not `arrayBuffer()`:
 *   `arrayBuffer()` materialises the whole body into a single V8 ArrayBuffer
 *   before releasing the native source. On a large response this is a real
 *   allocation spike that defeats the point of the leak fix (we would be
 *   doing the work we want to avoid). chunked drain reads in 16 KiB chunks;
 *   each chunk is released as soon as the next is read, so the concurrent
 *   peak is bounded to one chunk (~16 KiB) regardless of body size. Bench
 *   numbers (Bun 1.3.2, 73 015-byte body, N=500):
 *
 *     arrayBuffer():           64.94 KB/req RSS growth, 247.9 ms/iter
 *     chunked 16 KiB drain:    18.78 KB/req RSS growth,  93.8 ms/iter
 *
 *     71% less RSS growth, 2.6x faster. chunked drain wins on both the leak
 *     metric and wall-clock.
 *
 * Same discard-site scope as the prior `cancelDiscardedResponseBody`
 * primitive: every Response ccflare obtained via `makeProxyRequest` and then
 * decided not to forward (429/529/401 failover `return null` paths and every
 * retry-loop overwrite) is drained before the decision is finalised. Live
 * streaming / SSE / `withSanitizedProxyHeaders` forward paths are
 * intentionally not touched — draining a body mid-forward would re-introduce
 * the silent-stream-truncation bug class this repo's
 * `fix/silent-stream-truncation` branch shipped to repair.
 *
 * Failover correctness takes precedence over leak mitigation: a drain that
 * throws is swallowed. We skip null bodies, bodies that are already locked
 * (another consumer is holding the buffer; their drain will release it),
 * and bodies whose stream has already errored (which the `try/catch`
 * around the read loop handles).
 *
 * The drain is fire-and-forget — we deliberately do NOT await. The
 * ReadableStream spec guarantees the source is released as soon as the
 * reader reaches `done`, even though the promise returned by the drain
 * helper may still be in-flight when the failover path returns `null`.
 * Awaiting the drain would block the failover on the network round-trip
 * that is already being abandoned; the whole point is to release the buffer
 * quickly and move on.
 *
 * Lives in its own module so the regression test can import the helper
 * directly without pulling in the proxy-operations.ts transitive
 * dependency chain (which loads cacheBodyStore → @better-ccflare/database,
 * and that module fails to initialise in worktrees where `bun install`
 * has not run). The 12 discard sites in proxy-operations.ts import this
 * helper and call it before each `return null;`.
 */
export function cancelDiscardedResponseBody(
	response: Response | null | undefined,
): void {
	if (!response) return;
	const body = response.body;
	if (!body || body.locked) return;
	// Fire and forget — see comment above for why we do not await.
	void drainBody(body).catch(() => {});
}

/**
 * Drain a ReadableStream by reading until done, dropping each chunk.
 * Exported for the regression test which exercises the drain directly.
 */
export async function drainBody(body: ReadableStream<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	try {
		while (true) {
			const { done } = await reader.read();
			if (done) return;
			// Drop the chunk on the floor — we just want the native
			// source drained so the off-heap buffer is released. The
			// chunk's underlying ArrayBuffer is released when the loop
			// overwrites `value` on the next read.
		}
	} finally {
		reader.releaseLock();
	}
}