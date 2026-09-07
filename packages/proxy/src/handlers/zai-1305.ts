/**
 * Zai signals "service overloaded" (code 1305) *inside* a successful SSE
 * stream: HTTP 200, content-type text/event-stream, and an error event in the
 * body. Nothing in the status line or headers says the request failed, so the
 * proxy has to look at the first chunk to notice.
 *
 * Kept in its own module (with only dependency-light imports) so it can be
 * unit-tested — proxy-operations.ts pulls in @better-ccflare/database
 * transitively and is not importable from tests.
 */
import { drainBody } from "./discard-body-cancel";

/**
 * Matches an SSE `data:` line carrying a JSON error object with code 1305,
 * e.g. `data: {"error":{"code":1305,"message":"...overloaded..."}}`. Anchored
 * on the numeric `code` field rather than a bare substring match so genuine
 * model output that happens to mention "1305" and "overloaded" (a token
 * count, an id, a sentence in a response) doesn't get misclassified as the
 * provider error and discarded/retried.
 */
const ZAI_1305_ERROR_PATTERN =
	/"error"\s*:\s*\{[^}]*"code"\s*:\s*1305\b[^}]*overloaded/i;

/**
 * True when an SSE chunk carries Zai's 1305 overload error.
 *
 * The error arrives as the very first chunk of the stream, before any model
 * output, and its exact envelope has changed across Zai releases — so this
 * matches loosely within a `"error": {...}` object rather than parsing a
 * fixed shape, while still requiring the numeric error code so ordinary model
 * text can't trip it.
 */
export function hasZai1305Error(chunk: string): boolean {
	return ZAI_1305_ERROR_PATTERN.test(chunk);
}

/**
 * Bound on how many leading bytes of a peeked SSE stream we accumulate
 * while scanning for the 1305 markers. The error event is tiny (well
 * under 1 KiB); this cap just prevents an unbounded accumulation if a
 * stream never produces a match.
 */
export const SSE_PEEK_MAX_BYTES = 4096;

/**
 * Bound on how long we wait for the 1305 markers to appear before giving
 * up and treating the stream as a normal (non-1305) response. Without
 * this, a slow/low-throughput stream that never accumulates
 * SSE_PEEK_MAX_BYTES nor a match would hold up first-token latency for as
 * long as the upstream keeps trickling bytes.
 */
export const SSE_PEEK_TIMEOUT_MS = 500;

/**
 * Peeks at the leading bytes of an SSE response body — via `clone()`, so
 * the original stream is untouched — looking for Zai's 1305 overload
 * markers, then always drains the rest of the clone so its native backing
 * buffer is released (see discard-body-cancel.ts for why an unread stream
 * branch leaks — issue #382/#437). Reads multiple chunks rather than just
 * the first one: the 1305 JSON event can be split across network/TLS chunk
 * boundaries, and a single-chunk read would miss markers straddling that
 * split. Bounded by both a byte cap and a time cap so a slow normal stream
 * can't be held up waiting for a match that will never come.
 */
export async function peekSseForZai1305(response: Response): Promise<boolean> {
	const clone = response.clone();
	const reader = clone.body?.getReader();
	if (!reader) return false;

	let matched = false;
	let buffered = "";
	const decoder = new TextDecoder();
	const deadline = Date.now() + SSE_PEEK_TIMEOUT_MS;
	try {
		while (buffered.length < SSE_PEEK_MAX_BYTES) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const result = await Promise.race([
				reader.read(),
				new Promise<"timeout">((resolve) =>
					setTimeout(() => resolve("timeout"), remaining),
				),
			]);
			if (result === "timeout") break;
			const { value, done } = result;
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			if (hasZai1305Error(buffered)) {
				matched = true;
				break;
			}
		}
	} catch {
		// If we can't read the stream, treat as no match.
	} finally {
		// On the timeout path a read is still pending on this reader. Do NOT
		// await reader.cancel() here to settle it first — on a cloned (tee'd)
		// stream, cancelling one branch while a read on that branch is still
		// in flight does not resolve until the pending read itself settles,
		// which for a slow upstream can be far past our own timeout, silently
		// re-introducing the stall this function exists to bound. Releasing
		// the lock directly is safe (it does not throw on a pending read) and
		// drainBody below acquires its own reader to finish releasing the
		// clone's native backing buffer (issue #382/#437).
		reader.releaseLock();
		void drainBody(clone.body as ReadableStream<Uint8Array>).catch(() => {});
	}

	return matched;
}
