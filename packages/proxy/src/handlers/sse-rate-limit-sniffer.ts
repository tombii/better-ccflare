/**
 * SSE rate-limit sniffer — observes mid-stream `event: error` frames that
 * carry a `"type": "rate_limit_error"` payload and fires a one-shot signal
 * so the main thread can mark the account rate-limited.
 *
 * Why this exists: the top-level `!isStream` guard in `response-processor.ts`
 * was removed so streaming 429 responses with `text/event-stream` bodies do
 * trigger failover (see issue #114, fix in `edd26da`). But Anthropic (and
 * every other SSE-shaped Claude provider) also emits rate-limit errors
 * partway through an otherwise-healthy stream when a user bursts over the
 * window mid-response. Those never hit the processProxyResponse path
 * because the upstream response status is 200; the rate-limit signal is
 * smuggled as an `event: error` SSE frame in the body.
 *
 * Design choices:
 *
 * 1. **Substring regex, not a full SSE parser.** A proper parser would
 *    buffer per-line, track `event:` / `data:` pairs, and JSON.parse the
 *    payload. For a single one-shot signal, that's over-engineered. The
 *    regex `"type"\s*:\s*"rate_limit_error"` matches the Anthropic error
 *    envelope directly; false positives require Claude to literally
 *    transcribe that exact quoted key-value pair into content, which is
 *    vanishingly rare and non-catastrophic (the consequence is one account
 *    marked rate-limited for 5h, recoverable on the next successful call).
 *
 * 2. **Only `rate_limit_error`.** `overloaded_error` and `api_error` have
 *    different failover semantics — overload is transient and typically
 *    global, api_error is request-scoped. Marking an account rate-limited
 *    on those would cause spurious failovers.
 *
 * 3. **Bounded rolling buffer (16KB).** Most SSE frames are <1KB, and the
 *    error envelope is <500 bytes. A 16KB window is generous enough to
 *    handle frame boundaries split across many small TCP chunks while
 *    keeping memory flat for multi-megabyte streams.
 *
 * 4. **One-shot.** After firing, `feed()` short-circuits to `false` so the
 *    main thread never double-marks an account within a single request.
 */

const RATE_LIMIT_MARKER = /"type"\s*:\s*"rate_limit_error"/;
const MAX_BUFFER_BYTES = 16 * 1024;

export interface SseRateLimitSniffer {
	/**
	 * Feed an outgoing stream chunk. Returns `true` exactly once — on the
	 * first chunk where the rolling buffer contains a rate-limit error
	 * marker — and `false` on every subsequent call.
	 */
	feed(chunk: Uint8Array): boolean;
}

/**
 * Create a stateful sniffer. One instance per streaming request.
 */
export function createSseRateLimitSniffer(): SseRateLimitSniffer {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let buffer = "";
	let fired = false;

	return {
		feed(chunk: Uint8Array): boolean {
			if (fired) return false;

			buffer += decoder.decode(chunk, { stream: true });

			// Keep the buffer bounded. We trim from the front to preserve
			// the most recent bytes, which is where an in-progress error
			// frame would be accumulating.
			if (buffer.length > MAX_BUFFER_BYTES) {
				buffer = buffer.slice(buffer.length - MAX_BUFFER_BYTES);
			}

			if (RATE_LIMIT_MARKER.test(buffer)) {
				fired = true;
				// Release the buffer; we won't need it again.
				buffer = "";
				return true;
			}

			return false;
		},
	};
}
