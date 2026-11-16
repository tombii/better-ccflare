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
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

let collector: UsageCollector;
let db: DatabaseOperations;
let writes: Array<() => Promise<void>>;
beforeEach(() => {
	core.setCostTrackingEnabled(true);
	DatabaseFactory.reset();
	DatabaseFactory.initialize(":memory:");
	db = DatabaseFactory.getInstance();
	writes = [];
	collector = new UsageCollector(
		db,
		{
			enqueue: (write: () => Promise<void>) => writes.push(write),
			canAcceptPayload: () => false,
			recordPayloadDrop: () => {},
		} as never,
		() => false,
		() => {},
	);
});
afterEach(() => {
	collector.dispose();
	DatabaseFactory.reset();
	mock.restore();
	core.setCostTrackingEnabled(true);
});

function start(id: string, costTrackingEpoch?: number | null) {
	collector.handleStart({
		type: "start",
		costTrackingEpoch,
		messageId: id,
		requestId: id,
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: {},
		isStream: false,
		providerName: "fixture",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
	} satisfies StartMessage);
}
function end(id: string) {
	return collector.handleEnd({
		type: "end",
		requestId: id,
		success: true,
		responseBody: Buffer.from(
			JSON.stringify({
				model: "claude-opus-4-6",
				usage: { input_tokens: 123, output_tokens: 45 },
			}),
		).toString("base64"),
	});
}
async function saved(id: string) {
	for (const write of writes.splice(0)) await write();
	return db
		.getAdapter()
		.get<{ cost_usd: number | null; total_tokens: number }>(
			"SELECT cost_usd,total_tokens FROM requests WHERE id=?",
			[id],
		);
}

describe("usage collection with cost tracking disabled", () => {
	it("preserves an ingress epoch through a gap before response collection begins", async () => {
		const estimate = spyOn(core, "estimateCostUSD").mockResolvedValue(99);
		const epoch = core.getCostTrackingEpoch();
		core.setCostTrackingEnabled(false);
		core.setCostTrackingEnabled(true);
		start("before-response", epoch);
		await end("before-response");
		expect(estimate).not.toHaveBeenCalled();
		expect(await saved("before-response")).toEqual({
			cost_usd: null,
			total_tokens: 168,
		});
	});
	it("keeps usage but records NULL without pricing, then resumes new requests", async () => {
		const estimate = spyOn(core, "estimateCostUSD").mockResolvedValue(4);
		core.setCostTrackingEnabled(false);
		start("off");
		await end("off");
		expect(estimate).not.toHaveBeenCalled();
		expect(await saved("off")).toEqual({ cost_usd: null, total_tokens: 168 });
		core.setCostTrackingEnabled(true);
		start("on");
		await end("on");
		expect(estimate).toHaveBeenCalledTimes(1);
		expect(await saved("on")).toEqual({ cost_usd: 4, total_tokens: 168 });
	});
	it("discards pricing already in flight across an off/on gap", async () => {
		let finish!: (value: number) => void;
		spyOn(core, "estimateCostUSD").mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		start("gap");
		const finalizing = end("gap");
		await Promise.resolve();
		await Promise.resolve();
		core.setCostTrackingEnabled(false);
		core.setCostTrackingEnabled(true);
		finish(99);
		await finalizing;
		expect(await saved("gap")).toEqual({ cost_usd: null, total_tokens: 168 });
	});
});
