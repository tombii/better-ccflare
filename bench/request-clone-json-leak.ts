/**
 * Request.clone().json() leak measurement for issue #382.
 *
 * On Bun 1.3.x a cloned, body-bearing Request read with `.json()` never frees
 * the clone's native body buffer, so a proxy that inspects the client body
 * that way leaks ~1x the body size on every request — off-heap, so heapUsed
 * stays flat while RSS climbs. Reading the same clone with `.text()` is
 * released normally, and Bun 1.4.0+ frees both.
 *
 * The measured process runs an upstream that streams a small SSE body and a
 * proxy mirroring proxy-operations.ts / model-mapping.ts: buffer the client
 * body with arrayBuffer(), build the provider Request from a Uint8Array, read
 * its JSON through a clone (json | text | none), forward with fetch through a
 * `new Request(providerRequest, { headers, signal })`, and pump the SSE back
 * through a ReadableStream. The client runs in a child process so its own
 * fetch allocations do not pollute the measurement. RSS is sampled after a
 * forced GC before and after N requests.
 *
 * Run:  bun run bench/request-clone-json-leak.ts [json|text|none] [N] [bodyKiB]
 *
 * Measured with this harness, N=300, 800 KiB body, 4 concurrent clients:
 *   Bun 1.3.11   json ~950 KiB/req    text ~17 KiB/req    none ~12 KiB/req
 *   Bun 1.4.1    json  ~18 KiB/req    text ~20 KiB/req    (fixed by Bun 1.4.0's
 *                                                          body/stream rewrite)
 * Bun 1.3.12 through 1.3.14 measure the same as 1.3.11. The non-leaking
 * numbers are allocator noise and do not grow with N.
 */

const MODE = (process.argv[2] ?? "json") as "json" | "text" | "none";
const N = Number(process.argv[3] ?? 300);
const BODY_KIB = Number(process.argv[4] ?? 800);
const CONCURRENCY = 4;
const WARMUP = 20;

if (process.argv[2] === "--client") {
	await runClient(
		process.argv[3],
		Number(process.argv[4]),
		Number(process.argv[5]),
	);
	process.exit(0);
}

const encoder = new TextEncoder();

// ---- upstream: consume the body, stream ~10 KiB of SSE back
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		await req.arrayBuffer();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(
					encoder.encode(
						'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
					),
				);
				for (let i = 0; i < 20; i++) {
					await Bun.sleep(1);
					controller.enqueue(
						encoder.encode(
							`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${"x".repeat(400)}"}}\n\n`,
						),
					);
				}
				controller.enqueue(
					encoder.encode(
						'event: message_stop\ndata: {"type":"message_stop"}\n\n',
					),
				);
				controller.close();
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});
const upstreamUrl = `http://127.0.0.1:${upstream.port}/v1/messages`;

// ---- proxy: the request-body path of proxy-operations.ts + model-mapping.ts
const proxy = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	maxRequestBodySize: 64 * 1024 * 1024,
	async fetch(req) {
		const buffer = await req.arrayBuffer(); // prepareRequestBody
		const providerRequest = new Request(upstreamUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: new Uint8Array(buffer),
			duplex: "half",
			signal: req.signal,
		} as RequestInit);

		// transformRequestBodyModel: inspect the JSON body without consuming it
		if (MODE === "json") {
			await providerRequest.clone().json();
		} else if (MODE === "text") {
			JSON.parse(await providerRequest.clone().text());
		}

		// makeProxyRequest
		const response = await fetch(
			new Request(providerRequest, {
				headers: new Headers(providerRequest.headers),
				signal: req.signal,
			}),
		);

		// teeStream-style pump
		const reader = response.body?.getReader();
		if (!reader) return new Response(null, { status: 502 });
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const { done, value } = await reader.read();
				if (done) {
					reader.releaseLock();
					controller.close();
					return;
				}
				controller.enqueue(value);
			},
		});
		return new Response(body, {
			status: response.status,
			headers: { "content-type": "text/event-stream" },
		});
	},
});
const proxyUrl = `http://127.0.0.1:${proxy.port}/v1/messages`;

async function settledRssKiB(): Promise<number> {
	Bun.gc(true);
	await Bun.sleep(100);
	Bun.gc(true);
	return Math.round(process.memoryUsage().rss / 1024);
}

async function drive(count: number): Promise<void> {
	const child = Bun.spawn(
		[
			"bun",
			import.meta.path,
			"--client",
			proxyUrl,
			String(count),
			String(BODY_KIB),
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	const code = await child.exited;
	if (code !== 0) throw new Error(`client exited with ${code}`);
}

await drive(WARMUP);
const before = await settledRssKiB();
const startedAt = performance.now();
await drive(N);
const elapsedMs = performance.now() - startedAt;
const after = await settledRssKiB();

console.log(
	JSON.stringify({
		bun: Bun.version,
		mode: MODE,
		requests: N,
		body_kib: BODY_KIB,
		rss_before_kib: before,
		rss_after_kib: after,
		kib_per_request: Math.round((after - before) / N),
		ms_per_request: Math.round(elapsedMs / N),
	}),
);
upstream.stop(true);
proxy.stop(true);

// ---- child process: the client
async function runClient(url: string, count: number, bodyKiB: number) {
	const filler =
		"Lorem ipsum — dolor sit amet, consectetur → adipiscing elit. ";
	const text = filler.repeat(
		Math.ceil((bodyKiB * 1024) / Buffer.byteLength(filler)),
	);
	const body = JSON.stringify({
		model: "claude-opus-5",
		messages: [{ role: "user", content: [{ type: "text", text }] }],
		max_tokens: 1024,
		stream: true,
	});
	let started = 0;
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (started < count) {
				started++;
				const res = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				});
				await res.text();
			}
		}),
	);
}
