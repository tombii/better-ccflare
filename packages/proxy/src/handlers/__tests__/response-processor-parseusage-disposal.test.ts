/**
 * Regression test for the abandoned-response-clone in the streaming
 * usage-extraction path of `updateAccountMetadata` (response-processor.ts).
 *
 * The clone handed to `provider.parseUsage` was previously never disposed —
 * its body was retained off-heap for the life of the request whenever
 * parseUsage returned early (unsupported content-type, no reader available)
 * without reading it. This mirrors the existing extractUsageInfo clone fix
 * (response-processor-clone-cancel.test.ts) but for the `isStream` branch.
 *
 * Contract under test:
 *   1. parseUsage receives a clone, not the original response.
 *   2. The clone's body is drained after parseUsage resolves, whether or
 *      not parseUsage itself consumed it.
 *   3. Usage extraction still produces correct results — disposal must not
 *      truncate a result parseUsage already read out.
 *   4. Disposal does not throw when the body is already locked/consumed, or
 *      when parseUsage rejects.
 *
 * Run: bun test packages/proxy/src/handlers/__tests__/response-processor-parseusage-disposal.test.ts
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

async function settleAsync() {
	await new Promise<void>((r) => setImmediate(r));
}

function makeCtx(opts: {
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		model: string;
	} | null;
	// If true, parseUsage reads the body to completion before returning.
	consumesBody?: boolean;
	// If true, parseUsage rejects instead of returning.
	throws?: boolean;
}) {
	const calls = {
		parseUsageArg: null as Response | null,
		updateRequestUsageCalls: [] as Array<unknown>,
	};

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => true,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			parseUsage: async (response: Response) => {
				calls.parseUsageArg = response;
				if (opts.throws) {
					throw new Error("provider blew up");
				}
				if (opts.consumesBody) {
					const body = response.body;
					if (body) {
						const reader = body.getReader();
						try {
							while (true) {
								const { done } = await reader.read();
								if (done) break;
							}
						} finally {
							reader.releaseLock();
						}
					}
				}
				return opts.usage;
			},
			extractUsageInfo: undefined,
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
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

describe("updateAccountMetadata — parseUsage clone lifecycle", () => {
	it("passes a clone to parseUsage and drains the clone's body after the await resolves", async () => {
		const account = makeAccount();
		const usage = {
			promptTokens: 7,
			completionTokens: 11,
			totalTokens: 18,
			model: "claude-stream",
		};
		const { ctx, calls } = makeCtx({ usage });

		const response = new Response(
			'event: message_start\ndata: {"message":{"usage":{"input_tokens":7,"output_tokens":11}}}\n\n',
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);

		await processProxyResponse(response, account, ctx, "req-stream-1");
		await settleAsync();

		expect(calls.parseUsageArg).not.toBeNull();
		expect(calls.parseUsageArg).toBeInstanceOf(Response);
		expect(calls.parseUsageArg).not.toBe(response);

		// parseUsage never touched the body here, so the drain in the finally
		// must have consumed it — a subsequent read reports done.
		const cloneBody = calls.parseUsageArg?.body;
		let observedDone = false;
		try {
			const reader = cloneBody?.getReader();
			const { done } = await reader.read();
			reader.releaseLock();
			observedDone = done;
		} catch {
			observedDone = true;
		}
		expect(observedDone).toBe(true);
	});

	it("drain does not truncate usage extraction when parseUsage itself reads the body", async () => {
		const account = makeAccount();
		const usage = {
			promptTokens: 100,
			completionTokens: 42,
			totalTokens: 142,
			model: "claude-stream-consumed",
		};
		const { ctx, calls } = makeCtx({ usage, consumesBody: true });

		const response = new Response(
			'event: message_start\ndata: {"message":{"usage":{"input_tokens":100,"output_tokens":42}}}\n\n',
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);

		await processProxyResponse(response, account, ctx, "req-stream-2");
		await settleAsync();

		expect(calls.updateRequestUsageCalls).toHaveLength(1);
		expect(calls.updateRequestUsageCalls[0]).toEqual(usage);
	});

	it("does not throw when parseUsage rejects (drain still runs in finally)", async () => {
		const account = makeAccount();
		const { ctx, calls } = makeCtx({ usage: null, throws: true });

		const response = new Response("event: ping\ndata: {}\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		await processProxyResponse(response, account, ctx, "req-stream-3");
		await settleAsync();

		expect(calls.updateRequestUsageCalls).toHaveLength(0);
	});

	it("does not throw when the clone's body is already locked by parseUsage", async () => {
		const account = makeAccount();
		const usage = {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			model: "claude-locked",
		};
		const { ctx, calls } = makeCtx({ usage, consumesBody: true });

		const response = new Response("event: ping\ndata: {}\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		await processProxyResponse(response, account, ctx, "req-stream-4");
		await settleAsync();

		expect(calls.updateRequestUsageCalls).toHaveLength(1);
		expect(calls.updateRequestUsageCalls[0]).toEqual(usage);
	});
});
