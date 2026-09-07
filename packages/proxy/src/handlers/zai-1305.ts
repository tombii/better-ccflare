/**
 * Zai signals "service overloaded" (code 1305) *inside* a successful SSE
 * stream: HTTP 200, content-type text/event-stream, and an error event in the
 * body. Nothing in the status line or headers says the request failed, so the
 * proxy has to look at the first chunk to notice.
 *
 * Kept in its own module so it can be unit-tested — proxy-operations.ts pulls
 * in @better-ccflare/database transitively and is not importable from tests.
 */

/**
 * True when an SSE chunk carries Zai's 1305 overload error.
 *
 * Deliberately a substring match rather than an SSE parse: the error arrives
 * as the very first chunk of the stream, before any model output, and its
 * exact envelope has changed across Zai releases. Both markers must be present
 * so an unrelated "1305" (a token count, an id) does not trip it.
 */
export function hasZai1305Error(chunk: string): boolean {
	return chunk.includes("1305") && chunk.includes("overloaded");
}
