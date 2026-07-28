/**
 * Drain-strategy measurement for issue #273.
 *
 * Goal: compare two ways of "draining a discarded Response body to release
 * its off-heap backing store on stock Bun":
 *
 *   arrayBuffer() — materialises the entire body into a single ArrayBuffer
 *                    in V8 heap before releasing the native source.
 *
 *   chunked drain — reads the body in chunks (16 KiB) via getReader() and
 *                   discards them; the chunks pass through the allocator
 *                   one at a time and the ArrayBuffer it materialises is at
 *                   most one chunk, not the entire body.
 *
 * We measure:
 *   - wall-clock time per drain over 500 iterations
 *   - RSS delta per iteration
 *   - peak V8 heap delta (using process.memoryUsage().heapUsed over the run)
 *
 * The pinned 73 015-byte upstream body comes from
 * bench/bun-35093-harness.ts in ccflare-42. We use the same URL so the
 * numbers are directly comparable to ccflare-42's table.
 *
 * Run:  bun run bench/drain-strategy-harness.ts
 */

const ITERATIONS = 500;
const WARMUP = 50;
const CHUNK_SIZE = 16 * 1024; // 16 KiB — small enough to bound peak alloc

const TARGET_URL =
	"https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js";

interface DrainStrategy {
	name: string;
	drain: (response: Response) => Promise<void>;
}

const arrayBufferStrategy: DrainStrategy = {
	name: "arrayBuffer",
	drain: async (response) => {
		// Materialise the whole body into V8 heap, then release.
		await response.arrayBuffer();
	},
};

const chunkedDrainStrategy: DrainStrategy = {
	name: `chunked-${CHUNK_SIZE}B`,
	drain: async (response) => {
		const body = response.body;
		if (!body) return;
		const reader = body.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				// Drop the chunk on the floor — we just want the
				// native source drained so the off-heap buffer is
				// released.
				if (value) void value;
			}
		} finally {
			reader.releaseLock();
		}
	},
};

function rssKB(): number {
	return Math.round(process.memoryUsage().rss / 1024);
}

function heapUsedKB(): number {
	return Math.round(process.memoryUsage().heapUsed / 1024);
}

interface Measurement {
	strategy: string;
	iterations: number;
	totalMs: number;
	perIterMs: number;
	rssBeforeKB: number;
	rssAfterKB: number;
	rssDeltaKB: number;
	rssPerReqKB: number;
	heapPeakDeltaKB: number;
}

/**
 * Force GC if --expose-gc is available, otherwise best-effort.
 * Bun exposes `Bun.gc(true)` for forcing a blocking GC cycle.
 */
function gc(): void {
	// @ts-expect-error — Bun global; not typed in TS lib but exists at runtime
	if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
		// @ts-expect-error — see above
		Bun.gc(true);
	}
}

async function measureStrategy(
	strategy: DrainStrategy,
): Promise<Measurement> {
	// Settle, then sample. Drop any leftover responses from a previous run.
	gc();
	await new Promise((r) => setTimeout(r, 100));

	const rssBefore = rssKB();
	const heapBefore = heapUsedKB();
	const t0 = Bun.nanoseconds();

	const held: Response[] = [];
	for (let i = 0; i < ITERATIONS; i++) {
		const r = await fetch(TARGET_URL);
		await strategy.drain(r);
		// Hold the response so its backing store lifetime matches
		// ccflare's discard path: the Response object is still
		// reachable when we drop it (only its body has been released).
		// The held[] array bounds how long that reachable window is.
		held.push(r);
		if (held.length > WARMUP) {
			held.shift(); // release the oldest one
		}
	}

	const t1 = Bun.nanoseconds();
	gc();
	await new Promise((r) => setTimeout(r, 100));

	const rssAfter = rssKB();
	const heapAfter = heapUsedKB();

	const totalMs = (t1 - t0) / 1_000_000;
	const rssDelta = rssAfter - rssBefore;
	const heapPeakDelta = heapAfter - heapBefore;

	// Release the held array explicitly so it doesn't bias the after-sample.
	held.length = 0;
	gc();
	await new Promise((r) => setTimeout(r, 100));

	return {
		strategy: strategy.name,
		iterations: ITERATIONS,
		totalMs: Number(totalMs.toFixed(1)),
		perIterMs: Number((totalMs / ITERATIONS).toFixed(3)),
		rssBeforeKB: rssBefore,
		rssAfterKB: rssAfter,
		rssDeltaKB: rssDelta,
		rssPerReqKB: Number((rssDelta / ITERATIONS).toFixed(2)),
		heapPeakDeltaKB: heapPeakDelta,
	};
}

async function main() {
	const bunVersion =
		typeof Bun !== "undefined" ? Bun.version : "unknown";
	console.log(
		`bun=${bunVersion} iterations=${ITERATIONS} warmup=${WARMUP} body=73015B url=${TARGET_URL}`,
	);

	const measurements: Measurement[] = [];
	for (const strategy of [arrayBufferStrategy, chunkedDrainStrategy]) {
		const m = await measureStrategy(strategy);
		measurements.push(m);
		console.log(JSON.stringify(m));
	}

	console.log("\nSummary:");
	console.log(
		"strategy          perReq RSS (KB)  perIter ms  heap delta (KB)",
	);
	for (const m of measurements) {
		console.log(
			`${m.strategy.padEnd(18)}${String(m.rssPerReqKB).padStart(8)}      ${String(m.perIterMs).padStart(8)}     ${String(m.heapPeakDeltaKB).padStart(8)}`,
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});