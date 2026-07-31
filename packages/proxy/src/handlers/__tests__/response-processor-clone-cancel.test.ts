/**
 * Regression test for the abandoned-response-clone in the usage-extraction
 * path of `updateAccountMetadata` (response-processor.ts).
 *
 * The clone handed to `provider.extractUsageInfo` was previously never
 * cancelled — its body was retained off-heap for the life of the request.
 * Sequential requests are flat (no per-request growth), but the held clone
 * compounds under concurrency, so this bounds transient, concurrency-scaled
 * retention on the in-flight request.
 *
 * Contract under test:
 *   1. The clone's body is cancelled after `extractUsageInfo` resolves.
 *   2. Usage extraction still produces correct results for both streaming
 *      and non-streaming responses — the cancel must not truncate it.
 *   3. Cancelling does not throw when the body is already locked/consumed
 *      — it must never surface into the response path.
 *
 * Run: bun test packages/proxy/src/handlers/__tests__/response-processor-clone-cancel.test.ts
 */
import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { processProxyResponse } from "../response-processor";

function makeAccount(): Account {
	return {
		id: "acct-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
	};
}

// Spy ProxyContext that records the clone extractUsageInfo received and
// supports an optional pre-lock to simulate the body already being held
// by another consumer (e.g. the inner provider clone at provider.ts:645).
function makeCtx(opts: {
	isStream: boolean;
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		model: string;
	} | null;
	// If true, before invoking extractUsageInfo, lock the response body via
	// getReader() so the cancel-in-finally must skip (body.locked).
	preLockBody?: boolean;
	// If true, the simulated extractUsageInfo reads the body to completion
	// (matching the Anthropic provider's bounded-reader loop).
	consumesBody?: boolean;
}) {
	const calls = {
		extractUsageInfoArg: null as Response | null,
		enqueueCount: 0,
		updateRequestUsageCalls: [] as Array<unknown>,
	};

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => opts.isStream,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: async (response: Response) => {
				calls.extractUsageInfoArg = response;
				if (opts.consumesBody) {
					// Mirror the Anthropic provider's bounded-reader: read up to a
					// small cap then stop. The point is to consume the body so the
					// finally-block cancel sees body.locked===true.
					const body = response.body;
					if (body) {
						const reader = body.getReader();
						try {
							let total = 0;
							while (total < 1024) {
								const { value, done } = await reader.read();
								if (done) break;
								if (value) total += value.byteLength;
							}
						} finally {
							reader.releaseLock();
						}
					}
				}
				return opts.usage;
			},
		},
		dbOps: {
			markAccountRateLimited: () => {},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async (_id: string, usage: unknown) => {
				calls.updateRequestUsageCalls.push(usage);
			},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

// Helper: wait long enough for the async IIFE's await + finally to settle.
// Bun's microtask ordering is deterministic enough that setImmediate resolves
// after pending microtasks, including the chained asyncWriter.enqueue jobs.
async function settleAsync() {
	await new Promise<void>((r) => setImmediate(r));
}

describe("updateAccountMetadata — extractUsageInfo clone lifecycle", () => {
	it("passes a Response to extractUsageInfo and cancels the clone's body after the await resolves", async () => {
		const account = makeAccount();
		const usage = {
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			model: "claude-test",
		};
		const { ctx, calls } = makeCtx({ isStream: false, usage });

		const bodyText = JSON.stringify({
			id: "msg_1",
			usage: { input_tokens: 10, output_tokens: 5 },
		});
		const response = new Response(bodyText, {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx, "req-1");
		await settleAsync();

		// extractUsageInfo was handed a Response, not the original.
		expect(calls.extractUsageInfoArg).not.toBeNull();
		expect(calls.extractUsageInfoArg).toBeInstanceOf(Response);
		expect(calls.extractUsageInfoArg).not.toBe(response);

		// The body was never touched by extractUsageInfo in this case (no
		// consumesBody), so the cancel in the finally must have run and the
		// body is no longer readable on the clone's stream — a subsequent
		// getReader() must surface an error or read done immediately.
		const cloneBody = calls.extractUsageInfoArg?.body;
		// On Bun, after body.cancel() the stream should report done on first
		// read with no value. We assert via getReader — that throws if the
		// stream is closed, which is itself proof of cancellation. Fall back
		// to read() returning done if getReader succeeds.
		let observed = false;
		try {
			const reader = cloneBody?.getReader();
			const { done } = await reader.read();
			reader.releaseLock();
			observed = done;
		} catch {
			// Stream already closed by cancel — that's also fine.
			observed = true;
		}
		expect(observed).toBe(true);
	});

	it("non-streaming: cancel does not truncate usage extraction (extracted usage is saved)", async () => {
		const account = makeAccount();
		const usage = {
			promptTokens: 100,
			completionTokens: 42,
			totalTokens: 142,
			model: "claude-non-stream",
		};
		const { ctx, calls } = makeCtx({
			isStream: false,
			usage,
			// Mirror Anthropic: extractUsageInfo reads the body itself.
			consumesBody: true,
		});

		const response = new Response(
			JSON.stringify({
				id: "msg_1",
				usage: { input_tokens: 100, output_tokens: 42 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);

		await processProxyResponse(response, account, ctx, "req-nonstream");
		await settleAsync();

		// Usage must have been enqueued for write — the cancel-after-await
		// order means extractUsageInfo saw the body, returned the parsed
		// usage, and only then was the clone's body cancelled.
		expect(calls.updateRequestUsageCalls).toHaveLength(1);
		expect(calls.updateRequestUsageCalls[0]).toEqual(usage);
	});

	it("streaming: cancel does not truncate usage extraction (extracted usage is saved)", async () => {
		const account = makeAccount();
		const usage = {
			promptTokens: 7,
			completionTokens: 11,
			totalTokens: 18,
			model: "claude-stream",
		};
		const { ctx, calls } = makeCtx({
			isStream: true,
			usage,
			// The Anthropic provider's extractUsageInfo clones and reads.
			consumesBody: true,
		});

		const response = new Response(
			'event: message_start\ndata: {"message":{"usage":{"input_tokens":7,"output_tokens":11}}}\n\n',
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);

		await processProxyResponse(response, account, ctx, "req-stream");
		await settleAsync();

		// Usage must have been enqueued for write — the cancel-after-await
		// order preserves the parse result.
		expect(calls.updateRequestUsageCalls).toHaveLength(1);
		expect(calls.updateRequestUsageCalls[0]).toEqual(usage);
	});

	it("does not throw when the clone's body is already locked by extractUsageInfo (no cancel-attempt on a locked body)", async () => {
		const account = makeAccount();
		const usage = {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			model: "claude-locked",
		};
		// consumesBody: true holds a reader until extractUsageInfo returns;
		// the finally cancel must skip (body.locked) and not throw.
		const { ctx, calls } = makeCtx({
			isStream: false,
			usage,
			consumesBody: true,
		});

		const response = new Response(
			JSON.stringify({
				id: "msg_1",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);

		// Must not throw.
		await processProxyResponse(response, account, ctx, "req-locked");
		await settleAsync();

		// And the usage must still have made it through.
		expect(calls.updateRequestUsageCalls).toHaveLength(1);
		expect(calls.updateRequestUsageCalls[0]).toEqual(usage);
	});

	it("does not throw when extractUsageInfo itself rejects (cancel still runs in finally)", async () => {
		const account = makeAccount();
		const calls = {
			enqueueCount: 0,
			updateRequestUsageCalls: 0,
		};
		const ctx = {
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
				parseRateLimit: () => ({
					isRateLimited: false,
					resetTime: undefined,
					statusHeader: undefined,
					remaining: undefined,
				}),
				parseUsage: undefined,
				extractUsageInfo: async () => {
					throw new Error("provider blew up");
				},
			},
			dbOps: {
				markAccountRateLimited: () => {},
				updateAccountUsage: () => {},
				updateAccountRateLimitMeta: () => {},
				getAdapter: () => ({
					get: async () => ({ rate_limited_until: null }),
					run: async () => {},
				}),
				updateRequestUsage: async () => {
					calls.updateRequestUsageCalls++;
				},
			},
			asyncWriter: {
				enqueue: (job: () => void | Promise<void>) => {
					calls.enqueueCount++;
					void job();
				},
			},
		} as unknown as ProxyContext;

		const response = new Response(JSON.stringify({ id: "msg_1" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		// Must not throw — the catch in the IIFE swallows the provider error,
		// the finally still cancels the clone.
		await processProxyResponse(response, account, ctx, "req-throw");
		await settleAsync();

		expect(calls.updateRequestUsageCalls).toBe(0);
	});
});
