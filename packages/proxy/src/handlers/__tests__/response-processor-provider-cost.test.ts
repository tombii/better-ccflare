/**
 * A cost the provider itself reports — the `anthropic-billing-cost` header, or
 * OpenRouter's body `usage.cost` — must reach the usage collector, which then
 * skips its own catalogue estimate. Without a collector it falls back to a
 * COALESCE UPDATE on the row.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import * as core from "@better-ccflare/core";
import { DatabaseFactory } from "@better-ccflare/database";
import type { Account } from "@better-ccflare/types";
import { initUsageCollector, type UsageCollector } from "../../usage-collector";
import type { ProxyContext } from "../proxy-types";
import { processProxyResponse } from "../response-processor";

const ACCOUNT = {
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
} satisfies Account;

const BODY = JSON.stringify({
	type: "message",
	model: "claude-opus-4-6",
	usage: { input_tokens: 123, output_tokens: 45 },
});

function makeCtx(providerName: string, isStream: boolean) {
	// The collector's own writes go through the shared in-memory DB; the mock
	// context only records the fallback writes made when it holds no state.
	const dbOps = DatabaseFactory.getInstance();
	const calls = {
		updateRequestCostCalls: [] as Array<[string, number]>,
		updateRequestUsageCalls: [] as Array<Record<string, unknown>>,
	};
	const ctx = {
		provider: {
			name: providerName,
			isStreamingResponse: () => isStream,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			extractUsageInfo: async () => ({
				model: "claude-opus-4-6",
				inputTokens: 123,
				outputTokens: 45,
			}),
			parseUsage: async () => ({
				model: "claude-opus-4-6",
				inputTokens: 123,
				outputTokens: 45,
			}),
		},
		dbOps: Object.assign(Object.create(dbOps), {
			updateRequestUsage: async (_id: string, usage: unknown) => {
				calls.updateRequestUsageCalls.push(usage as Record<string, unknown>);
			},
			updateRequestCost: async (id: string, costUsd: number) => {
				calls.updateRequestCostCalls.push([id, costUsd]);
				await dbOps.updateRequestCost(id, costUsd);
			},
		}),
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				void job();
			},
		},
	} as unknown as ProxyContext;
	return { ctx, calls };
}

async function settleAsync() {
	await new Promise<void>((r) => setImmediate(r));
}

async function rowCost(id: string) {
	await settleAsync();
	return DatabaseFactory.getInstance()
		.getAdapter()
		.get<{ cost_usd: number | null }>(
			"SELECT cost_usd FROM requests WHERE id=?",
			[id],
		);
}

let collector: UsageCollector;
let estimate: ReturnType<typeof spyOn>;
beforeEach(async () => {
	core.setCostTrackingEnabled(true);
	DatabaseFactory.reset();
	DatabaseFactory.initialize(":memory:");
	estimate = spyOn(core, "estimateCostUSD").mockResolvedValue(99);
	// Share the test's in-memory database: a collector built with its own
	// DatabaseOperations would write to a second, unrelated connection.
	collector = await initUsageCollector(
		() => false,
		() => {},
		DatabaseFactory.getInstance(),
	);
});
afterEach(() => {
	collector.dispose();
	DatabaseFactory.reset();
	mock.restore();
	core.setCostTrackingEnabled(true);
});

function start(requestId: string, isStream: boolean) {
	collector.handleStart({
		type: "start",
		messageId: requestId,
		requestId,
		accountId: ACCOUNT.id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: {},
		isStream,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: ACCOUNT.name,
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
	});
}

describe("provider-reported cost reaches the collector", () => {
	it("uses the anthropic-billing-cost header over the local estimate", async () => {
		const { ctx } = makeCtx("anthropic", false);
		const id = "req-header";
		start(id, false);
		await processProxyResponse(
			new Response(BODY, {
				status: 200,
				headers: {
					"content-type": "application/json",
					"anthropic-billing-cost": "0.0123",
				},
			}),
			ACCOUNT,
			ctx,
			id,
		);
		await settleAsync();
		await collector.handleEnd({
			type: "end",
			requestId: id,
			success: true,
			responseBody: Buffer.from(BODY).toString("base64"),
		});
		await collector.drain();
		expect(await rowCost(id)).toEqual({ cost_usd: 0.0123 });
	});

	it("uses the header on a stream", async () => {
		const { ctx } = makeCtx("anthropic", true);
		const SSE = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-6", usage: { input_tokens: 123, output_tokens: 1 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 45 } })}\n\n`;
		const id = "req-stream";
		start(id, true);
		await processProxyResponse(
			new Response(SSE, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"anthropic-billing-cost": "0.5",
				},
			}),
			ACCOUNT,
			ctx,
			id,
		);
		await settleAsync();
		// A stream reaches the collector as chunks, then an end with no body.
		collector.handleChunk(id, new TextEncoder().encode(SSE));
		await collector.handleEnd({
			type: "end",
			requestId: id,
			success: true,
		});
		await collector.drain();
		expect(await rowCost(id)).toEqual({ cost_usd: 0.5 });
	});

	it("ignores an invalid cost from the provider parser too", async () => {
		const { ctx } = makeCtx("anthropic", false);
		ctx.provider.extractUsageInfo = async () => ({
			model: "claude-opus-4-6",
			inputTokens: 123,
			outputTokens: 45,
			costUsd: Number.NaN,
		});
		const id = "req-parser-nan";
		start(id, false);
		await processProxyResponse(
			new Response(BODY, {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			ACCOUNT,
			ctx,
			id,
		);
		await settleAsync();
		await collector.handleEnd({
			type: "end",
			requestId: id,
			success: true,
			responseBody: Buffer.from(BODY).toString("base64"),
		});
		await collector.drain();
		expect(await rowCost(id)).toEqual({ cost_usd: 99 });
	});

	it("ignores a malformed header and estimates instead", async () => {
		const { ctx } = makeCtx("anthropic", false);
		const id = "req-bad";
		start(id, false);
		await processProxyResponse(
			new Response(BODY, {
				status: 200,
				headers: {
					"content-type": "application/json",
					"anthropic-billing-cost": "NaN",
				},
			}),
			ACCOUNT,
			ctx,
			id,
		);
		await collector.handleEnd({
			type: "end",
			requestId: id,
			success: true,
			responseBody: Buffer.from(BODY).toString("base64"),
		});
		await collector.drain();
		expect(estimate).toHaveBeenCalledTimes(1);
		expect(await rowCost(id)).toEqual({ cost_usd: 99 });
	});

	it("falls back to a row UPDATE when the collector tracks no such request", async () => {
		const { ctx, calls } = makeCtx("anthropic", false);
		await processProxyResponse(
			new Response(BODY, {
				status: 200,
				headers: {
					"content-type": "application/json",
					"anthropic-billing-cost": "0.02",
				},
			}),
			ACCOUNT,
			ctx,
			"req-untracked",
		);
		await settleAsync();
		expect(calls.updateRequestCostCalls).toEqual([["req-untracked", 0.02]]);
	});
});
