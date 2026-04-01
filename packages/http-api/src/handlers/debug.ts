/**
 * Debug endpoints for memory profiling and diagnostics.
 * These endpoints expose bun:jsc heap statistics and heap snapshots
 * for diagnosing memory leaks without external tooling.
 *
 * Endpoints:
 *   GET /api/debug/heap       — JSC heap stats (object counts by type)
 *   GET /api/debug/snapshot   — Generate V8-compatible .heapsnapshot
 *   GET /api/debug/rss        — Current process RSS in MB
 */

// @ts-expect-error — bun:jsc types are incomplete; generateHeapSnapshotForDebugging exists at runtime
import { generateHeapSnapshotForDebugging, heapStats } from "bun:jsc";

/**
 * Returns JSC heap statistics — object counts by type, heap size,
 * extra memory (native allocations outside JSC). Diff two calls
 * to see what's accumulating.
 */
export function createHeapStatsHandler() {
	return (): Response => {
		const stats = heapStats();
		const rss = process.memoryUsage.rss();

		return Response.json({
			rss_mb: Math.round(rss / 1024 / 1024),
			timestamp: new Date().toISOString(),
			heap: stats,
		});
	};
}

/**
 * Generates a V8-compatible .heapsnapshot file. Open in Chrome DevTools
 * (Memory tab → Load) to inspect object graph. Large — typically 50-200MB.
 *
 * WARNING: generateHeapSnapshotForDebugging() is synchronous and blocks the
 * event loop for several seconds. Only use on a test/staging instance, never
 * on a production proxy under load. Admin-only endpoint.
 *
 * Usage: curl http://localhost:8889/api/debug/snapshot > before.heapsnapshot
 *        # ... run load ...
 *        curl http://localhost:8889/api/debug/snapshot > after.heapsnapshot
 *        # Diff in Chrome DevTools Memory tab
 */
export function createHeapSnapshotHandler() {
	return (): Response => {
		const snapshot = generateHeapSnapshotForDebugging();
		return new Response(JSON.stringify(snapshot), {
			headers: {
				"content-type": "application/json",
				"content-disposition": `attachment; filename="heap-${Date.now()}.heapsnapshot"`,
			},
		});
	};
}

/**
 * Lightweight RSS check — just the number, no heap walk.
 * Use for continuous monitoring: while true; do curl -s .../rss; sleep 30; done
 */
export function createRssHandler() {
	return (): Response => {
		const rss = process.memoryUsage.rss();
		return Response.json({
			rss_bytes: rss,
			rss_mb: Math.round(rss / 1024 / 1024),
			timestamp: new Date().toISOString(),
			uptime_s: Math.round(process.uptime()),
		});
	};
}
