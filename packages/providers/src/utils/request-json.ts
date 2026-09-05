/**
 * Read a Request's JSON body without consuming the Request.
 *
 * Do NOT write `request.clone().json()` for this. On Bun 1.3.x (measured on
 * 1.3.11 through 1.3.14) the `.json()` read of a cloned, body-bearing Request
 * never frees the clone's native body buffer: every call leaks the full
 * request body off-heap, invisible to `heapUsed`, heap snapshots and
 * `/api/debug/heap`. On a proxy fronting Claude Code that is ~1 MiB per
 * request — the multi-GB RSS growth in issue #382, which survived the earlier
 * reader-lock and response-clone fixes because it sits on the request side.
 *
 * Reading the same clone with `.text()` (or `.arrayBuffer()`) releases the
 * buffer normally, and Bun 1.4.0+ frees both. bench/request-clone-json-leak.ts
 * reproduces the measurement.
 */
export async function readRequestJson<T = unknown>(
	request: Request,
): Promise<T> {
	return JSON.parse(await request.clone().text()) as T;
}
