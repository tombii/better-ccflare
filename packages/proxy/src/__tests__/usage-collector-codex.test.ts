import { beforeEach, describe, expect, it, mock } from "bun:test";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

function makeStart(overrides: Partial<StartMessage> = {}): StartMessage {
	return {
		type: "start",
		messageId: "msg-1",
		requestId: "req-codex-1",
		accountId: "codex-acc-1",
		method: "POST",
		path: "/v1/codex/responses",
		timestamp: Date.now() - 500,
		requestHeaders: {},
		requestBody: Buffer.from(
			JSON.stringify({ model: "gpt-5.3-codex", stream: true }),
		).toString("base64"),
		requestedModel: "gpt-5.3-codex",
		project: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "text/event-stream" },
		isStream: true,
		providerName: "codex",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: 0,
		accountName: "codex",
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
		clientPath: "/v1/codex/responses",
		upstreamPath: "/responses",
		routingMode: "native",
		...overrides,
	};
}

function codexSse(lines: Array<[string, Record<string, unknown>]>): string {
	return `${lines
		.map(
			([event, data]) =>
				`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n`,
		)
		.join("\n")}\n`;
}

type SavedUsage = {
	model?: string;
	totalTokens?: number;
	costUsd?: number;
	tokensPerSecond?: number;
};

function usageFromSaveCall(
	saveRequest: ReturnType<typeof mock>,
): SavedUsage | undefined {
	return saveRequest.mock.calls[0]?.[9] as SavedUsage | undefined;
}

describe("UsageCollector codex-native observability", () => {
	let saveRequest: ReturnType<typeof mock>;
	let collector: UsageCollector;

	beforeEach(() => {
		saveRequest = mock(() => Promise.resolve());
		collector = new UsageCollector(
			{
				saveRequest,
				updateAccountUsage: mock(() => Promise.resolve()),
				pauseAccount: mock(() => Promise.resolve()),
			} as never,
			{
				enqueue: mock(() => {}),
				enqueueMetadataAndWait: async (fn: () => Promise<void>) => {
					await fn();
					return "saved" as const;
				},
				enqueuePayload: () => true,
				canAcceptPayload: () => true,
				recordPayloadDrop: () => {},
				dispose: async () => {},
			} as never,
			() => false,
			() => {},
		);
	});

	it("persists model, tokens, cost, and throughput for streaming response.completed", async () => {
		collector.handleStart(makeStart());

		const sse = codexSse([
			[
				"response.completed",
				{
					response: {
						model: "gpt-5.3-codex",
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
			],
		]);
		collector.handleChunk("req-codex-1", new TextEncoder().encode(sse));
		await collector.handleEnd({
			type: "end",
			requestId: "req-codex-1",
			success: true,
		});

		expect(saveRequest).toHaveBeenCalledTimes(1);
		const usage = usageFromSaveCall(saveRequest);
		expect(usage?.model).toBe("gpt-5.3-codex");
		expect(usage?.totalTokens).toBe(15);
		expect(usage?.costUsd).toBeDefined();
		expect(usage?.tokensPerSecond).toBeGreaterThan(0);
	});

	it("persists model from response.created when completed omits model", async () => {
		collector.handleStart(
			makeStart({ requestedModel: null, requestBody: null }),
		);

		const sse = codexSse([
			[
				"response.created",
				{ response: { id: "resp_1", model: "gpt-5.3-codex" } },
			],
			[
				"response.completed",
				{ response: { usage: { input_tokens: 3, output_tokens: 2 } } },
			],
		]);
		collector.handleChunk("req-codex-1", new TextEncoder().encode(sse));
		await collector.handleEnd({
			type: "end",
			requestId: "req-codex-1",
			success: true,
		});

		const usage = usageFromSaveCall(saveRequest);
		expect(usage?.model).toBe("gpt-5.3-codex");
		expect(usage?.totalTokens).toBe(5);
	});

	it("persists model, tokens, and cost for non-streaming JSON responses", async () => {
		collector.handleStart(
			makeStart({
				isStream: false,
				responseHeaders: { "content-type": "application/json" },
			}),
		);

		const body = JSON.stringify({
			id: "resp_json",
			object: "response",
			model: "gpt-5.3-codex",
			usage: { input_tokens: 8, output_tokens: 4 },
		});
		await collector.handleEnd({
			type: "end",
			requestId: "req-codex-1",
			success: true,
			responseBody: Buffer.from(body).toString("base64"),
		});

		const usage = usageFromSaveCall(saveRequest);
		expect(usage?.model).toBe("gpt-5.3-codex");
		expect(usage?.totalTokens).toBe(12);
		expect(usage?.costUsd).toBeDefined();
	});

	it("falls back to requestedModel when response omits model", async () => {
		collector.handleStart(
			makeStart({ requestBody: null, requestedModel: "gpt-5.3-codex" }),
		);

		const sse = codexSse([
			[
				"response.completed",
				{ response: { usage: { input_tokens: 6, output_tokens: 1 } } },
			],
		]);
		collector.handleChunk("req-codex-1", new TextEncoder().encode(sse));
		await collector.handleEnd({
			type: "end",
			requestId: "req-codex-1",
			success: true,
		});

		const usage = usageFromSaveCall(saveRequest);
		expect(usage?.model).toBe("gpt-5.3-codex");
		expect(usage?.totalTokens).toBe(7);
	});

	it("parses data-only SSE lines without event prefixes", async () => {
		collector.handleStart(makeStart());

		const sse =
			'data: {"type":"response.completed","response":{"model":"gpt-5.3-codex","usage":{"input_tokens":4,"output_tokens":2}}}\n\n';
		collector.handleChunk("req-codex-1", new TextEncoder().encode(sse));
		await collector.handleEnd({
			type: "end",
			requestId: "req-codex-1",
			success: true,
		});

		const usage = usageFromSaveCall(saveRequest);
		expect(usage?.model).toBe("gpt-5.3-codex");
		expect(usage?.totalTokens).toBe(6);
	});

	it("records billing type plan and account id for codex provider", async () => {
		collector.handleStart(makeStart());

		const sse = codexSse([
			[
				"response.completed",
				{
					response: {
						model: "gpt-5.3-codex",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			],
		]);
		collector.handleChunk("req-codex-1", new TextEncoder().encode(sse));
		await collector.handleEnd({
			type: "end",
			requestId: "req-codex-1",
			success: true,
		});

		const args = saveRequest.mock.calls[0];
		expect(args[3]).toBe("codex-acc-1");
		expect(args[14]).toBe("plan");
		expect(args[2]).toBe("/v1/codex/responses");
	});

	it("persists error rows with request model but without token usage", async () => {
		collector.handleStart(
			makeStart({
				responseStatus: 502,
				responseHeaders: { "content-type": "application/json" },
			}),
		);

		await collector.handleEnd({
			type: "end",
			requestId: "req-codex-1",
			success: false,
			error: "upstream unavailable",
			responseBody: Buffer.from(
				JSON.stringify({ error: "bad gateway" }),
			).toString("base64"),
		});

		expect(saveRequest).toHaveBeenCalledTimes(1);
		const usage = usageFromSaveCall(saveRequest);
		expect(usage?.model).toBe("gpt-5.3-codex");
		expect(usage?.totalTokens).toBe(0);
		expect(saveRequest.mock.calls[0][5]).toBe(false);
		expect(saveRequest.mock.calls[0][6]).toBe("upstream unavailable");
	});
});
