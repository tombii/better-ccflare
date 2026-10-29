/**
 * The backend an OpenRouter response body names as having served a request
 * (`provider`, e.g. "Morph") must reach `provider_served` through the usage
 * UPDATE that runs after the body was already consumed — and must stay absent
 * for providers that do not state it and for streams.
 */
import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { UsageCollector } from "../../usage-collector";
import type { StartMessage } from "../../worker-messages";
import type { ProxyContext } from "../proxy-types";
import { processProxyResponse } from "../response-processor";

function makeAccount(provider: string): Account {
	return {
		id: "acct-1",
		name: "test-account",
		provider,
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

const USAGE = {
	promptTokens: 10,
	completionTokens: 2,
	totalTokens: 12,
	model: "deepseek/deepseek-v4.1-flash-1017",
};

/** Recorded live OpenRouter /v1/messages 200 body (2026-10-29), trimmed. */
const OPENROUTER_BODY = JSON.stringify({
	id: "msg_0123456789",
	type: "message",
	role: "assistant",
	model: "deepseek/deepseek-v4.1-flash-1017",
	provider: "Morph",
	content: [{ type: "text", text: "ok" }],
	usage: { input_tokens: 10, output_tokens: 2, cost: 0.0000078 },
});

function makeCtx(providerName: string, isStream = false) {
	const calls = {
		updateRequestUsageCalls: [] as Array<Record<string, unknown>>,
		updateRequestProviderServedCalls: [] as Array<[string, string]>,
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
			extractUsageInfo: async () => ({ ...USAGE }),
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
				calls.updateRequestUsageCalls.push(usage as Record<string, unknown>);
			},
			updateRequestProviderServed: async (id: string, served: string) => {
				calls.updateRequestProviderServedCalls.push([id, served]);
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

describe("updateAccountMetadata — provider_served", () => {
	it("persists the openrouter serving provider alongside usage", async () => {
		const { ctx, calls } = makeCtx("openrouter");
		const response = new Response(OPENROUTER_BODY, {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(
			response,
			makeAccount("openrouter"),
			ctx,
			"req-served-1",
		);
		await settleAsync();

		expect(calls.updateRequestUsageCalls).toHaveLength(1);
		expect(calls.updateRequestUsageCalls[0]).toEqual(USAGE);
		expect(calls.updateRequestProviderServedCalls).toEqual([
			["req-served-1", "Morph"],
		]);
	});

	it("does not read a body or record a serving provider for other providers", async () => {
		const { ctx, calls } = makeCtx("nanogpt");
		const response = new Response(OPENROUTER_BODY, {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(
			response,
			makeAccount("nanogpt"),
			ctx,
			"req-served-2",
		);
		await settleAsync();

		expect(calls.updateRequestUsageCalls).toHaveLength(1);
		expect(calls.updateRequestProviderServedCalls).toHaveLength(0);
	});
});

describe("UsageCollector — provider_served summary", () => {
	function makeStart(overrides: Partial<StartMessage>): StartMessage {
		return {
			type: "start",
			messageId: "m",
			requestId: "req-summary",
			accountId: "acct-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {},
			isStream: false,
			providerName: "openrouter",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			comboName: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
			...overrides,
		};
	}

	function run(providerName: string, responseBody: string) {
		const summaries: Array<{ providerServed?: string }> = [];
		const saved: Array<{ usage?: Record<string, unknown> }> = [];
		const collector = new UsageCollector(
			{
				saveRequest: async (...args: unknown[]) => {
					saved.push({ usage: args[9] as Record<string, unknown> | undefined });
				},
				updateAccountUsage: async () => {},
			} as never,
			{
				// Run the save job synchronously so the test can assert on it.
				enqueue: (job: () => void | Promise<void>) => {
					void job();
				},
				enqueuePayload: () => false,
			} as never,
			() => false,
			(summary) => {
				summaries.push(summary as { providerServed?: string });
			},
		);
		return (async () => {
			collector.handleStart(
				makeStart({
					providerName,
					responseBody: null,
				}) as StartMessage,
			);
			await collector.handleEnd({
				type: "end",
				requestId: "req-summary",
				success: true,
				responseBody: Buffer.from(responseBody).toString("base64"),
			});
			collector.dispose();
			return { summaries, saved };
		})();
	}

	it("records providerServed from a non-stream openrouter body", async () => {
		const { summaries, saved } = await run("openrouter", OPENROUTER_BODY);
		expect(summaries[0]?.providerServed).toBe("Morph");
		expect(saved[0]?.usage).toMatchObject({ providerServed: "Morph" });
	});

	it("leaves providerServed absent for nanogpt", async () => {
		const { summaries, saved } = await run("nanogpt", OPENROUTER_BODY);
		expect(summaries[0]?.providerServed).toBeUndefined();
		expect(saved[0]?.usage?.providerServed).toBeUndefined();
	});
});
