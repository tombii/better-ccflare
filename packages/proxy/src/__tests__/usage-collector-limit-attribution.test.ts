import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as core from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	getApiKeySpendCounter,
	resetApiKeySpendCounter,
} from "../handlers/api-key-spend";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const startMs = Date.parse("2026-11-13T12:59:59Z");
const endMs = startMs + 2000;
const collectors: UsageCollector[] = [];
afterEach(() => {
	for (const collector of collectors) collector.dispose();
	collectors.length = 0;
	resetApiKeySpendCounter();
	mock.restore();
});
function harness() {
	const db = {
		saveRequest: mock(async () => {}),
	} as unknown as DatabaseOperations;
	const writer = {
		enqueue: mock(() => {}),
		canAcceptPayload: () => false,
		recordPayloadDrop: () => {},
		dispose: async () => {},
	};
	const collector = new UsageCollector(
		db,
		writer as never,
		() => false,
		() => {},
	);
	collectors.push(collector);
	const counter = getApiKeySpendCounter(db);
	const record = spyOn(counter, "record");
	const start: StartMessage = {
		type: "start",
		messageId: "msg",
		requestId: "request",
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: startMs,
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: {},
		isStream: false,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		comboName: null,
		apiKeyId: "key",
		apiKeyName: "budget",
		retryAttempt: 0,
		failoverAttempts: 0,
		limitModel: "gpt-5.4",
		originalModel: "claude-sonnet-4-5",
	};
	return { collector, counter, record, start };
}
const responseBody = Buffer.from(
	JSON.stringify({
		model: "claude-opus-4-5",
		usage: { input_tokens: 100, output_tokens: 20 },
		content: [],
	}),
).toString("base64");
it("records actual served model with original scope association in the completion window", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(startMs);
	spyOn(core, "estimateCostUSD").mockResolvedValue(0.25);
	const { collector, record, start } = harness();
	collector.handleStart(start);
	clock.mockReturnValue(endMs);
	await collector.handleEnd({
		type: "end",
		requestId: "request",
		success: true,
		responseBody,
	});
	expect(record).toHaveBeenCalledWith(
		"key",
		0.25,
		"claude-opus-4-5",
		endMs,
		"request",
		"gpt-5.4",
	);
	expect(collector.hasPendingRequest("request")).toBe(false);
});
it("retains collector ownership while pricing is pending after the stream ended", async () => {
	spyOn(Date, "now").mockReturnValue(endMs);
	let finish!: (cost: number) => void;
	spyOn(core, "estimateCostUSD").mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const { collector, record, start } = harness();
	collector.handleStart(start);
	const pending = collector.handleEnd({
		type: "end",
		requestId: "request",
		success: true,
		responseBody,
	});
	expect(collector.hasPendingRequest("request")).toBe(true);
	expect(record).not.toHaveBeenCalled();
	await Promise.resolve();
	await Promise.resolve();
	finish(0.25);
	await pending;
	expect(collector.hasPendingRequest("request")).toBe(false);
	expect(record).toHaveBeenCalledTimes(1);
});
