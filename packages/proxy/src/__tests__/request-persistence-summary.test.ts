import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { RequestResponse } from "@better-ccflare/types";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

function makeStart(overrides: Partial<StartMessage> = {}): StartMessage {
	return {
		type: "start",
		messageId: "msg-1",
		requestId: "req-persist-1",
		accountId: "acc-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now() - 100,
		requestHeaders: {},
		requestBody: null,
		requestedModel: "claude-haiku-4-5-20251001",
		project: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "application/json" },
		isStream: false,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: 0,
		accountName: "test",
		agentUsed: "claude-code-1",
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
		clientPath: "/v1/messages",
		upstreamPath: null,
		routingMode: null,
		...overrides,
	};
}

describe("UsageCollector request persistence vs SSE summary", () => {
	let saveRequest: ReturnType<typeof mock>;
	let enqueueMetadataAndWait: ReturnType<typeof mock>;
	let onSummary: ReturnType<typeof mock>;
	let collector: UsageCollector;

	beforeEach(() => {
		saveRequest = mock(() => Promise.resolve());
		onSummary = mock((_summary: RequestResponse) => {});
		enqueueMetadataAndWait = mock(async (job: () => Promise<void>) => {
			await job();
			return "saved" as const;
		});

		collector = new UsageCollector(
			{
				saveRequest,
				updateAccountUsage: mock(() => Promise.resolve()),
				pauseAccount: mock(() => Promise.resolve()),
			} as never,
			{
				enqueue: mock(() => {}),
				enqueueMetadataAndWait,
				enqueuePayload: () => true,
				canAcceptPayload: () => true,
				recordPayloadDrop: () => {},
				dispose: async () => {},
			} as never,
			() => false,
			onSummary,
		);
	});

	it("emits summary only after saveRequest completes", async () => {
		const order: string[] = [];
		saveRequest.mockImplementation(async () => {
			order.push("saveRequest");
		});
		onSummary.mockImplementation(() => {
			order.push("onSummary");
		});

		collector.handleStart(makeStart());
		await collector.handleEnd({
			type: "end",
			requestId: "req-persist-1",
			success: true,
			responseBody: Buffer.from(
				JSON.stringify({
					type: "message",
					model: "claude-haiku-4-5-20251001",
					usage: { input_tokens: 10, output_tokens: 5 },
				}),
			).toString("base64"),
		});

		expect(saveRequest).toHaveBeenCalledTimes(1);
		expect(onSummary).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["saveRequest", "onSummary"]);
	});

	it("marks summary persisted=true when metadata save succeeds", async () => {
		collector.handleStart(makeStart());
		await collector.handleEnd({
			type: "end",
			requestId: "req-persist-1",
			success: true,
			responseBody: Buffer.from(
				JSON.stringify({
					type: "message",
					model: "claude-haiku-4-5-20251001",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			).toString("base64"),
		});

		const summary = onSummary.mock.calls[0]?.[0] as RequestResponse;
		expect(summary.persisted).toBe(true);
		expect(summary.persistenceFailed).toBeUndefined();
	});

	it("does not emit a completed summary when metadata save is dropped", async () => {
		enqueueMetadataAndWait.mockResolvedValue("dropped");

		collector.handleStart(makeStart());
		await collector.handleEnd({
			type: "end",
			requestId: "req-persist-1",
			success: true,
			responseBody: Buffer.from(
				JSON.stringify({
					type: "message",
					model: "claude-haiku-4-5-20251001",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			).toString("base64"),
		});

		expect(saveRequest).not.toHaveBeenCalled();
		expect(onSummary).toHaveBeenCalledTimes(1);
		const summary = onSummary.mock.calls[0]?.[0] as RequestResponse;
		expect(summary.persisted).toBe(false);
		expect(summary.persistenceFailed).toBe(true);
	});

	it("marks persistenceFailed when saveRequest throws", async () => {
		saveRequest.mockRejectedValue(new Error("db down"));
		enqueueMetadataAndWait.mockImplementation(
			async (job: () => Promise<void>) => {
				try {
					await job();
					return "saved" as const;
				} catch {
					return "failed" as const;
				}
			},
		);

		collector.handleStart(makeStart());
		await collector.handleEnd({
			type: "end",
			requestId: "req-persist-1",
			success: true,
			responseBody: Buffer.from(
				JSON.stringify({
					type: "message",
					model: "claude-haiku-4-5-20251001",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			).toString("base64"),
		});

		const summary = onSummary.mock.calls[0]?.[0] as RequestResponse;
		expect(summary.persisted).toBe(false);
		expect(summary.persistenceFailed).toBe(true);
	});

	it("does not emit summary until enqueueMetadataAndWait job finishes", async () => {
		let releaseSave!: () => void;
		const saveBlocked = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		saveRequest.mockImplementation(() => saveBlocked);
		enqueueMetadataAndWait.mockImplementation(
			async (job: () => Promise<void>) => {
				await job();
				return "saved" as const;
			},
		);

		collector.handleStart(makeStart());
		const endPromise = collector.handleEnd({
			type: "end",
			requestId: "req-persist-1",
			success: true,
			responseBody: Buffer.from(
				JSON.stringify({
					type: "message",
					model: "claude-haiku-4-5-20251001",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			).toString("base64"),
		});

		await Bun.sleep(20);
		expect(saveRequest).toHaveBeenCalled();
		expect(onSummary).not.toHaveBeenCalled();

		releaseSave();
		await endPromise;
		expect(onSummary).toHaveBeenCalledTimes(1);
	});
});
