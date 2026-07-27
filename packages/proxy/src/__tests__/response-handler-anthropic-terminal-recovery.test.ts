import { describe, expect, it, mock, spyOn } from "bun:test";
import { ANTHROPIC_MESSAGE_STOP_FRAME } from "../anthropic-terminal-recovery";
import type { ProxyContext } from "../handlers";

// The source worktree intentionally excludes generated database worker bundles.
// ResponseHandler only reaches DatabaseOperations/AsyncDbWriter construction
// through UsageCollector's getUsageCollector() fallback, which this filtered
// probe path never initializes or calls: every ProxyContext below passes
// hand-rolled dbOps: {} / asyncWriter: {} fakes, and getUsageCollector itself
// is spied/replaced per-test where needed. So @better-ccflare/database's real
// exports are never touched here — do NOT add a
// mock.module("@better-ccflare/database", ...) stub for
// DatabaseOperations/AsyncDbWriter/DatabaseFactory: it isn't needed, and
// mock.module replaces the WHOLE module globally with no per-file isolation
// (no --isolate in this bun version) and is pre-evaluated for every test file
// before any test runs, so such a stub would corrupt DatabaseFactory's
// process-wide singleton for every other test file, including ones that run
// (and complete) before this file's own afterAll could restore it.
const usageCollectorModule = await import("../usage-collector");
const { forwardToClient } = await import("../response-handler");

const encoder = new TextEncoder();
const terminalDelta =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n';

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function immediateStream(chunk: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});
}

function nativeAnthropicCtx(providerName = "anthropic"): ProxyContext {
	return {
		strategy: {},
		dbOps: {},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => true },
		provider: {
			name: providerName,
			isStreamingResponse: () => true,
		},
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {},
		internalProbeSecret: "test-secret",
	} as unknown as ProxyContext;
}

async function forwardClosedStream({
	requestHeaders,
	providerName = "anthropic",
	path = "/v1/messages",
	method = "POST",
	status = 200,
	contentType = "text/event-stream; charset=utf-8",
}: {
	requestHeaders: Headers;
	providerName?: string;
	path?: string;
	method?: string;
	status?: number;
	contentType?: string;
}): Promise<string> {
	const response = await forwardToClient(
		{
			requestId: crypto.randomUUID(),
			method,
			path,
			account: null,
			requestHeaders,
			requestBody: bytes("{}"),
			response: new Response(immediateStream(bytes(terminalDelta)), {
				status,
				headers: { "content-type": contentType },
			}),
			timestamp: Date.now(),
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		nativeAnthropicCtx(providerName),
	);

	return response.text();
}

describe("forwardToClient Anthropic terminal recovery integration", () => {
	it("recovers only native Anthropic Messages SSE responses", async () => {
		const requestHeaders = new Headers({
			"anthropic-version": "2023-06-01",
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});

		await expect(forwardClosedStream({ requestHeaders })).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
	});

	it("feeds synthesized framing through the normal usage lifecycle", async () => {
		const chunks: Uint8Array[] = [];
		const ends: Array<Record<string, unknown>> = [];
		const collector = {
			handleStart: mock(() => undefined),
			handleChunk: mock((_requestId: string, data: Uint8Array) => {
				chunks.push(data);
			}),
			handleEnd: mock((message: Record<string, unknown>) => {
				ends.push(message);
				return Promise.resolve();
			}),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const requestId = "normal-recovered-request";
			const response = await forwardToClient(
				{
					requestId,
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"anthropic-version": "2023-06-01",
					}),
					requestBody: bytes("{}"),
					response: new Response(immediateStream(bytes(terminalDelta)), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				nativeAnthropicCtx(),
			);

			await expect(response.text()).resolves.toBe(
				`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(collector.handleStart).toHaveBeenCalledTimes(1);
			expect(Buffer.concat(chunks).toString()).toBe(
				`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
			);
			expect(ends).toEqual([
				expect.objectContaining({
					requestId,
					success: true,
					type: "end",
				}),
			]);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("leaves non-Messages streams unchanged", async () => {
		// Native anthropic was previously the only provider gated into the
		// recovery wrapper. Generalization: the gate is now path+content-type+status
		// only, so any anthropic-compatible provider speaking the same wire
		// format (e.g. minimax) on /v1/messages with text/event-stream also
		// gets the recovery synthesis. Non-Messages paths still bypass.
		const filteredHeaders = new Headers({
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});
		const nativeHeaders = new Headers(filteredHeaders);
		nativeHeaders.set("anthropic-version", "2023-06-01");

		// Missing anthropic-version header on native anthropic still gets
		// recovery — the header is no longer part of the gate.
		await expect(
			forwardClosedStream({ requestHeaders: filteredHeaders }),
		).resolves.toBe(`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`);
		// anthropic-compatible on /v1/messages SSE: now enters the wrapper
		// and synthesizes the closing message_stop. Previously this was
		// silent-stream-truncation on minimax.
		await expect(
			forwardClosedStream({
				requestHeaders: nativeHeaders,
				providerName: "anthropic-compatible",
			}),
		).resolves.toBe(`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`);
		// /v1/complete is a non-Messages path: still passthrough.
		await expect(
			forwardClosedStream({
				requestHeaders: nativeHeaders,
				path: "/v1/complete",
			}),
		).resolves.toBe(terminalDelta);
	});

	it("leaves GET, non-2xx, and non-SSE Anthropic Messages responses unchanged", async () => {
		const nativeHeaders = new Headers({
			"anthropic-version": "2023-06-01",
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});

		await expect(
			forwardClosedStream({ requestHeaders: nativeHeaders, method: "GET" }),
		).resolves.toBe(terminalDelta);
		await expect(
			forwardClosedStream({ requestHeaders: nativeHeaders, status: 500 }),
		).resolves.toBe(terminalDelta);
		await expect(
			forwardClosedStream({
				requestHeaders: nativeHeaders,
				contentType: "application/json",
			}),
		).resolves.toBe(terminalDelta);
	});
});

describe("forwardToClient SSE terminal-state propagation", () => {
	function makeContentOnlyStream(): ReadableStream<Uint8Array> {
		// Mid-content only — no terminal message_delta, no message_stop.
		// Mirrors the ccmax/minimax IncompleteRead signature where bytes
		// flow then the upstream TCP closes before any stop_reason lands.
		const content =
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n' +
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
		return immediateStream(bytes(content));
	}

	it("records success:false and state=truncated when SSE closes without any terminal event", async () => {
		// Reproduces the header-only-success bug: a 200 OK with truncated
		// content used to be silently recorded as success. The recovery
		// wrapper now classifies it as "truncated" and response-handler
		// records success:false.
		const ends: Array<Record<string, unknown>> = [];
		const collector = {
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock((message: Record<string, unknown>) => {
				ends.push(message);
				return Promise.resolve();
			}),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const requestId = "truncated-request";
			const response = await forwardToClient(
				{
					requestId,
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"anthropic-version": "2023-06-01",
					}),
					requestBody: bytes("{}"),
					response: new Response(makeContentOnlyStream(), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				nativeAnthropicCtx(),
			);

			await expect(response.text()).resolves.toBe(
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
					'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n' +
					'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(ends).toEqual([
				expect.objectContaining({
					requestId,
					success: false,
					error: "stream_truncated_mid_content",
					streamTerminalState: "truncated",
					type: "end",
				}),
			]);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("records state=truncated for anthropic-compatible providers (minimax coverage)", async () => {
		// The original bug only affected provider.name !== "anthropic".
		// Generalization: any provider on /v1/messages with SSE content-type
		// gets the same detection. Verifies minimax-shaped providers
		// surface the truncated state too.
		const ends: Array<Record<string, unknown>> = [];
		const collector = {
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock((message: Record<string, unknown>) => {
				ends.push(message);
				return Promise.resolve();
			}),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const requestId = "truncated-anthropic-compatible";
			const response = await forwardToClient(
				{
					requestId,
					method: "POST",
					path: "/v1/messages",
					account: null,
					// Notably NO anthropic-version header — the gate no longer
					// requires it.
					requestHeaders: new Headers({}),
					requestBody: bytes("{}"),
					response: new Response(makeContentOnlyStream(), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				nativeAnthropicCtx("anthropic-compatible"),
			);

			await expect(response.text()).resolves.toBe(
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
					'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n' +
					'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(ends).toEqual([
				expect.objectContaining({
					requestId,
					success: false,
					error: "stream_truncated_mid_content",
					streamTerminalState: "truncated",
					type: "end",
				}),
			]);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("preserves success:true and records state=client_cancelled when the client disconnects mid-stream", async () => {
		// Claude Code cancels streams routinely (Esc, tool interrupts,
		// client aborts). Those are NOT upstream failures or proxy defects
		// — recording them as success:false would poison the success-rate
		// metrics at a much higher rate than the upstream TCP-close rate
		// the bug fix addresses. The fix preserves the prior header-based
		// success bit and surfaces the specific outcome via the new column.
		const ends: Array<Record<string, unknown>> = [];
		const collector = {
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock((message: Record<string, unknown>) => {
				ends.push(message);
				return Promise.resolve();
			}),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const requestId = "client-cancelled-request";
			const source = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes(terminalDelta));
				},
			});
			const response = await forwardToClient(
				{
					requestId,
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"anthropic-version": "2023-06-01",
					}),
					requestBody: bytes("{}"),
					response: new Response(source, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				nativeAnthropicCtx(),
			);

			// Client disconnect — simulates user hitting Esc mid-response.
			// We cancel the downstream reader directly and swallow any
			// upstream-cancel rejection (the immediateStream source has
			// already closed, so cancelling it surfaces "Invalid state" —
			// irrelevant to the recording semantics we're testing).
			const reader = response.body?.getReader();
			await reader.cancel("client disconnect").catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Find the end emitted with client_cancelled (the close path
			// from cancel()) — there may be a subsequent error end from the
			// upstream-cancel rejection, which is a separate concern.
			const cancelEnd = ends.find(
				(e) => e.streamTerminalState === "client_cancelled",
			);
			expect(cancelEnd).toBeDefined();
			expect(cancelEnd).toMatchObject({
				requestId,
				// Header-based success preserved — not a proxy defect.
				success: true,
				streamTerminalState: "client_cancelled",
				type: "end",
			});
		} finally {
			collectorSpy.mockRestore();
		}
	});
});
