import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { isValidClaudeModel } from "../../../core/src/model-mappings";
import { CLAUDE_MODEL_IDS } from "../../../core/src/models";
import type { EndMessage, StartMessage } from "../worker-messages";

interface PricingTokens {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

type PricingImplementation = (
	model: string,
	tokens: PricingTokens,
) => Promise<number>;

let pricingImplementation: PricingImplementation = async () => 0;
const estimateCostUSD = mock((model: string, tokens: PricingTokens) =>
	pricingImplementation(model, tokens),
);

mock.module("@better-ccflare/core", () => ({
	BUFFER_SIZES: {
		STREAM_TEE_MAX_BYTES: 1024 * 1024,
		STREAM_USAGE_BUFFER_KB: 64,
	},
	CLAUDE_MODEL_IDS,
	estimateCostUSD,
	isValidClaudeModel,
	TIME_CONSTANTS: {
		HOUR: 60 * 60 * 1000,
		MINUTE: 60 * 1000,
		SECOND: 1000,
		STREAM_TIMEOUT_DEFAULT: 60 * 1000,
	},
}));

mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class {},
	DatabaseOperations: class {},
}));

const { UsageCollector } = await import("../usage-collector");
type UsageCollectorInstance = InstanceType<typeof UsageCollector>;

const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

interface TestHarness {
	collector: UsageCollectorInstance;
	payloadDrops: number[];
	saveRequestIds: string[];
	payloads: Map<string, string>;
	summaryCosts: Map<string, number | undefined>;
	summaries: string[];
	writerState: { disposed: boolean };
}

interface TestRequestState {
	startMessage: StartMessage;
	buffer: string;
	chunks: Uint8Array[];
	chunksBytes: number;
	chunksTruncated: boolean;
	payloadReleased: boolean;
	retainedPayloadBytes: number;
	usage: {
		model?: string;
		outputTokens?: number;
	};
}

interface TestableCollector {
	_handleEndInternal(msg: EndMessage): Promise<void>;
	activePayloadBytes: number;
	cleanupStaleRequests(): void;
	missingStateWarnings: Set<string>;
	pendingPayloadBytes: number;
	pendingPayloadCount: number;
	pricingTimeoutMs: number;
	requests: Map<string, TestRequestState>;
}

function makeStartMessage(
	requestId: string,
	overrides: Partial<StartMessage> = {},
): StartMessage {
	return {
		type: "start",
		messageId: `message-${requestId}`,
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "text/event-stream" },
		isStream: true,
		providerName: "anthropic",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		originalModel: null,
		appliedModel: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
		...overrides,
		requestId,
	};
}

function createHarness(storePayloads = false): TestHarness {
	const saveRequestIds: string[] = [];
	const payloads = new Map<string, string>();
	const payloadDrops: number[] = [];
	const summaryCosts = new Map<string, number | undefined>();
	const summaries: string[] = [];
	const writerState = { disposed: false };
	const pendingWrites = new Set<Promise<void>>();

	const dbOps = {
		async saveRequest(requestId: string): Promise<void> {
			saveRequestIds.push(requestId);
		},
		async saveRequestPayloadRaw(
			requestId: string,
			payload: string,
		): Promise<void> {
			payloads.set(requestId, payload);
		},
	};

	const asyncWriter = {
		enqueue(task: () => Promise<void> | void): void {
			const pending = Promise.resolve().then(task);
			pendingWrites.add(pending);
			void pending.finally(() => pendingWrites.delete(pending));
		},
		async dispose(): Promise<void> {
			await Promise.allSettled([...pendingWrites]);
			writerState.disposed = true;
		},
		canAcceptPayload(): boolean {
			return true;
		},
		recordPayloadDrop(bytes: number): void {
			payloadDrops.push(bytes);
		},
		enqueuePayload(
			_requestId: string,
			_bytes: number,
			task: () => Promise<void> | void,
		): boolean {
			this.enqueue(task);
			return true;
		},
	};

	const collector = new UsageCollector(
		dbOps as never,
		asyncWriter as never,
		() => storePayloads,
		(summary) => {
			summaries.push(summary.id);
			summaryCosts.set(summary.id, summary.costUsd);
		},
	);

	return {
		collector,
		payloadDrops,
		saveRequestIds,
		payloads,
		summaries,
		summaryCosts,
		writerState,
	};
}

function testable(collector: UsageCollectorInstance): TestableCollector {
	return collector as unknown as TestableCollector;
}

function modelBearingChunk(): Uint8Array {
	return new TextEncoder().encode(
		'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
	);
}

describe("UsageCollector request lifecycle", () => {
	const realDateNow = Date.now;
	const previousPricingTimeout = process.env.CF_PRICING_TIMEOUT_MS;
	const previousStreamTimeout = process.env.CF_STREAM_TIMEOUT_MS;
	let now = 1_700_000_000_000;
	const collectors: UsageCollectorInstance[] = [];

	beforeEach(() => {
		now = 1_700_000_000_000;
		Date.now = () => now;
		delete process.env.CF_PRICING_TIMEOUT_MS;
		process.env.CF_STREAM_TIMEOUT_MS = String(INACTIVITY_TIMEOUT_MS);
		pricingImplementation = async () => 0;
		estimateCostUSD.mockClear();
	});

	afterEach(() => {
		for (const collector of collectors.splice(0)) collector.dispose();
		Date.now = realDateNow;
		if (previousPricingTimeout === undefined) {
			delete process.env.CF_PRICING_TIMEOUT_MS;
		} else {
			process.env.CF_PRICING_TIMEOUT_MS = previousPricingTimeout;
		}
		if (previousStreamTimeout === undefined) {
			delete process.env.CF_STREAM_TIMEOUT_MS;
		} else {
			process.env.CF_STREAM_TIMEOUT_MS = previousStreamTimeout;
		}
	});

	function harness(storePayloads = false): TestHarness {
		const value = createHarness(storePayloads);
		collectors.push(value.collector);
		return value;
	}

	it("keeps an actively chunking stream beyond two minutes and persists it on end", async () => {
		const { collector, saveRequestIds, summaries } = harness();
		collector.handleStart(makeStartMessage("active-stream"));

		for (const elapsed of [30_000, 60_000, 90_000, 121_000]) {
			now = 1_700_000_000_000 + elapsed;
			collector.handleChunk(
				"active-stream",
				new TextEncoder().encode(": ping\n\n"),
			);
			testable(collector).cleanupStaleRequests();
		}

		expect(testable(collector).requests.has("active-stream")).toBe(true);
		await collector.handleEnd({
			type: "end",
			requestId: "active-stream",
			success: true,
		});
		await collector.drain();

		expect(saveRequestIds).toEqual(["active-stream"]);
		expect(summaries).toEqual(["active-stream"]);
		expect(testable(collector).requests.has("active-stream")).toBe(false);
	});

	it("snapshots a finalizing payload before pricing yields and promptly releases its request state", async () => {
		const { collector, payloads } = harness(true);
		const requestBody = Buffer.from("old request body").toString("base64");
		collector.handleStart(
			makeStartMessage("finalizing-stream", {
				requestBody,
				requestHeaders: { "x-lifecycle": "old" },
			}),
		);
		collector.handleChunk("finalizing-stream", modelBearingChunk());
		const finalizingState =
			testable(collector).requests.get("finalizing-stream");
		expect(finalizingState).toBeDefined();

		const endPromise = collector.handleEnd({
			type: "end",
			requestId: "finalizing-stream",
			success: true,
		});
		const detachedBeforePricingResolved =
			!testable(collector).requests.has("finalizing-stream");

		now += 1;
		for (let i = 0; i <= 10_000; i++) {
			collector.handleStart(makeStartMessage(`race-capacity-${i}`));
		}
		const payloadStateReleasedBeforePricingResolved =
			finalizingState?.chunks.length === 0 &&
			finalizingState.chunksBytes === 0 &&
			finalizingState.startMessage.requestBody === null &&
			Object.keys(finalizingState.startMessage.requestHeaders).length === 0;

		await endPromise;
		await collector.drain();

		const savedPayload = JSON.parse(
			payloads.get("finalizing-stream") ?? "null",
		);
		expect(detachedBeforePricingResolved).toBe(true);
		expect(payloadStateReleasedBeforePricingResolved).toBe(true);
		expect(savedPayload.request.body).toBe(requestBody);
		expect(savedPayload.request.headers).toEqual({ "x-lifecycle": "old" });
		expect(
			Buffer.from(savedPayload.response.body, "base64").toString("utf8"),
		).toContain("message_start");
	});

	it("bounds serialized payloads waiting behind pricing", async () => {
		process.env.CF_PRICING_TIMEOUT_MS = "60000";
		pricingImplementation = () => new Promise<number>(() => {});
		const { collector, payloadDrops, payloads } = harness(true);
		const requestBody = Buffer.from("bounded payload").toString("base64");

		// Simulate the collector-local pending-finalizer capacity already being full.
		testable(collector).pendingPayloadCount = 1_000;
		collector.handleStart(
			makeStartMessage("bounded-finalizer", {
				requestBody,
				requestHeaders: { "x-payload": "bounded" },
			}),
		);
		collector.handleChunk("bounded-finalizer", modelBearingChunk());
		const state = testable(collector).requests.get("bounded-finalizer");

		const endPromise = collector.handleEnd({
			type: "end",
			requestId: "bounded-finalizer",
			success: true,
		});

		expect(state?.startMessage.requestBody).toBeNull();
		expect(state?.startMessage.requestHeaders).toEqual({});
		expect(state?.chunks).toEqual([]);
		expect(payloadDrops).toHaveLength(1);
		expect(testable(collector).pendingPayloadCount).toBe(1_000);

		await collector.drain();
		await endPromise;
		expect(payloads.has("bounded-finalizer")).toBe(false);
	});

	it("does not delete a new same-ID lifecycle when the old finalizer completes", async () => {
		const { collector, payloads } = harness(true);
		const oldRequestBody = Buffer.from("old lifecycle").toString("base64");
		const newRequestBody = Buffer.from("new lifecycle").toString("base64");
		collector.handleStart(
			makeStartMessage("reused-finalizing-id", {
				requestBody: oldRequestBody,
			}),
		);
		collector.handleChunk("reused-finalizing-id", modelBearingChunk());

		const endPromise = collector.handleEnd({
			type: "end",
			requestId: "reused-finalizing-id",
			success: true,
		});
		const detachedBeforeReuse = !testable(collector).requests.has(
			"reused-finalizing-id",
		);

		now += 1;
		collector.handleStart(
			makeStartMessage("reused-finalizing-id", {
				requestBody: newRequestBody,
			}),
		);
		const newLifecycle = testable(collector).requests.get(
			"reused-finalizing-id",
		);
		await endPromise;
		await collector.drain();

		const savedPayload = JSON.parse(
			payloads.get("reused-finalizing-id") ?? "null",
		);
		expect(detachedBeforeReuse).toBe(true);
		expect(testable(collector).requests.get("reused-finalizing-id")).toBe(
			newLifecycle,
		);
		expect(newLifecycle?.startMessage.requestBody).toBe(newRequestBody);
		expect(savedPayload.request.body).toBe(oldRequestBody);
	});

	it("bounds a hung pricing estimate and releases detached request state", async () => {
		process.env.CF_PRICING_TIMEOUT_MS = "20";
		pricingImplementation = () => new Promise<number>(() => {});
		const { collector, saveRequestIds, summaryCosts } = harness(true);
		const largeRequestBody = Buffer.alloc(256 * 1024, "r").toString("base64");
		collector.handleStart(
			makeStartMessage("pricing-timeout", {
				requestBody: largeRequestBody,
				requestHeaders: { "x-large-state": "true" },
			}),
		);
		collector.handleChunk("pricing-timeout", modelBearingChunk());
		collector.handleChunk(
			"pricing-timeout",
			new Uint8Array(128 * 1024).fill(120),
		);
		const detachedState = testable(collector).requests.get("pricing-timeout");
		expect(detachedState?.chunksBytes).toBeGreaterThan(128 * 1024);
		expect(detachedState?.startMessage.requestBody).toBe(largeRequestBody);

		const pricingWarnings: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (
				event.msg === "Pricing estimate timed out; using zero-cost fallback"
			) {
				pricingWarnings.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			const endPromise = collector.handleEnd({
				type: "end",
				requestId: "pricing-timeout",
				success: true,
			});
			const completedWithinBound = await Promise.race([
				endPromise.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
			]);
			if (completedWithinBound) await collector.drain();

			expect(completedWithinBound).toBe(true);
			expect(saveRequestIds).toContain("pricing-timeout");
			expect(summaryCosts.get("pricing-timeout")).toBe(0);
			expect(detachedState?.chunks).toEqual([]);
			expect(detachedState?.chunksBytes).toBe(0);
			expect(detachedState?.buffer).toBe("");
			expect(detachedState?.startMessage.requestBody).toBeNull();
			expect(detachedState?.startMessage.requestHeaders).toEqual({});
			expect(pricingWarnings).toHaveLength(1);
			expect(pricingWarnings[0]?.data).toEqual({
				model: "claude-sonnet-4-5-20250929",
				requestId: "pricing-timeout",
				timeoutMs: 20,
			});
		} finally {
			logBus.off("log", onLog);
		}
	});

	it("drain forces current pricing waits to zero without waiting for the configured deadline", async () => {
		process.env.CF_PRICING_TIMEOUT_MS = "60000";
		pricingImplementation = () => new Promise<number>(() => {});
		const { collector, summaryCosts } = harness();
		collector.handleStart(makeStartMessage("drain-pricing"));
		collector.handleChunk("drain-pricing", modelBearingChunk());
		const endPromise = collector.handleEnd({
			type: "end",
			requestId: "drain-pricing",
			success: true,
		});

		const drainedPromptly = await Promise.race([
			collector.drain().then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
		]);
		await endPromise;

		expect(drainedPromptly).toBe(true);
		expect(summaryCosts.get("drain-pricing")).toBe(0);
	});

	it("drain waits for handleEnd work registered while its first snapshot settles", async () => {
		process.env.CF_PRICING_TIMEOUT_MS = "60000";
		pricingImplementation = () => new Promise<number>(() => {});
		const { collector, saveRequestIds, summaries, writerState } = harness();
		for (const requestId of ["drain-first", "drain-second"]) {
			collector.handleStart(makeStartMessage(requestId));
			collector.handleChunk(requestId, modelBearingChunk());
		}

		let releaseSecond = () => {};
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const target = testable(collector);
		const originalHandleEnd = target._handleEndInternal.bind(collector);
		target._handleEndInternal = async (msg: EndMessage) => {
			if (msg.requestId === "drain-second") await secondGate;
			return originalHandleEnd(msg);
		};

		const firstEnd = collector.handleEnd({
			type: "end",
			requestId: "drain-first",
			success: true,
		});
		const drainPromise = collector.drain();
		const secondEnd = collector.handleEnd({
			type: "end",
			requestId: "drain-second",
			success: true,
		});

		try {
			const returnedBeforeSecondSettled = await Promise.race([
				drainPromise.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
			]);
			expect(returnedBeforeSecondSettled).toBe(false);
			expect(writerState.disposed).toBe(false);
		} finally {
			releaseSecond();
		}

		await Promise.all([firstEnd, secondEnd, drainPromise]);
		expect(saveRequestIds.sort()).toEqual(["drain-first", "drain-second"]);
		expect(summaries.sort()).toEqual(["drain-first", "drain-second"]);
		expect(writerState.disposed).toBe(true);
	});

	it("clears the pricing deadline timer when estimation finishes quickly", async () => {
		process.env.CF_PRICING_TIMEOUT_MS = "20";
		pricingImplementation = async () => 0.25;
		const { collector, summaryCosts } = harness();
		const pricingWarnings: LogEvent[] = [];
		const onLog = (event: LogEvent) => {
			if (
				event.msg === "Pricing estimate timed out; using zero-cost fallback"
			) {
				pricingWarnings.push(event);
			}
		};
		logBus.on("log", onLog);

		try {
			collector.handleStart(makeStartMessage("fast-pricing"));
			collector.handleChunk("fast-pricing", modelBearingChunk());
			await collector.handleEnd({
				type: "end",
				requestId: "fast-pricing",
				success: true,
			});
			await collector.drain();
			await new Promise((resolve) => setTimeout(resolve, 40));

			expect(summaryCosts.get("fast-pricing")).toBe(0.25);
			expect(pricingWarnings).toEqual([]);
		} finally {
			logBus.off("log", onLog);
		}
	});

	it("accepts only integer pricing deadlines in the inclusive supported range", () => {
		const cases: Array<{
			configured: string | undefined;
			expected: number;
		}> = [
			{ configured: "1", expected: 1 },
			{ configured: "60000", expected: 60_000 },
			{ configured: "0", expected: 5_000 },
			{ configured: "60001", expected: 5_000 },
			{ configured: "1.5", expected: 5_000 },
			{ configured: "not-a-number", expected: 5_000 },
			{ configured: undefined, expected: 5_000 },
		];

		for (const { configured, expected } of cases) {
			if (configured === undefined) {
				delete process.env.CF_PRICING_TIMEOUT_MS;
			} else {
				process.env.CF_PRICING_TIMEOUT_MS = configured;
			}

			const { collector } = harness();
			expect(testable(collector).pricingTimeoutMs).toBe(expected);
		}
	});

	it("evicts a stream that exceeds the inactivity timeout", async () => {
		const { collector, saveRequestIds } = harness();
		collector.handleStart(makeStartMessage("inactive-stream"));

		now += INACTIVITY_TIMEOUT_MS + 1;
		testable(collector).cleanupStaleRequests();

		expect(testable(collector).requests.has("inactive-stream")).toBe(false);
		await collector.handleEnd({
			type: "end",
			requestId: "inactive-stream",
			success: false,
			error: "downstream disconnected",
		});
		await collector.drain();
		expect(saveRequestIds).toEqual([]);
	});

	it("keeps parser state but permanently releases payload capture for an old active stream", async () => {
		const { collector, payloads, saveRequestIds } = harness(true);
		const requestBody = Buffer.from("old active request").toString("base64");
		collector.handleStart(
			makeStartMessage("old-active-stream", {
				requestBody,
				requestHeaders: { "x-old-active": "true" },
				responseHeaders: { "x-response": "old-active" },
			}),
		);
		collector.handleChunk("old-active-stream", modelBearingChunk());
		const state = testable(collector).requests.get("old-active-stream");
		expect(state?.chunks.length).toBeGreaterThan(0);

		now += 2 * 60 * 1000 + 1;
		collector.handleChunk(
			"old-active-stream",
			new TextEncoder().encode(": keep-alive\n\n"),
		);
		testable(collector).cleanupStaleRequests();

		expect(testable(collector).requests.has("old-active-stream")).toBe(true);
		expect(state?.payloadReleased).toBe(true);
		expect(state?.startMessage.requestBody).toBeNull();
		expect(state?.startMessage.requestHeaders).toEqual({});
		expect(state?.startMessage.responseHeaders).toEqual({});
		expect(state?.chunks).toEqual([]);
		expect(state?.chunksBytes).toBe(0);
		expect(state?.chunksTruncated).toBe(true);

		collector.handleChunk(
			"old-active-stream",
			new TextEncoder().encode(
				'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
			),
		);
		expect(state?.usage.outputTokens).toBe(7);
		expect(state?.chunks).toEqual([]);
		expect(state?.chunksBytes).toBe(0);

		await collector.handleEnd({
			type: "end",
			requestId: "old-active-stream",
			success: true,
		});
		await collector.drain();

		expect(saveRequestIds).toEqual(["old-active-stream"]);
		expect(payloads.has("old-active-stream")).toBe(false);
	});

	it("releases one active request payload when its next chunk would exceed the global byte budget", async () => {
		const { collector, payloadDrops } = harness(true);
		const requestBody = Buffer.from("budgeted request body").toString("base64");
		collector.handleStart(
			makeStartMessage("active-budget", {
				requestBody,
				requestHeaders: { "x-active-budget": "true" },
			}),
		);
		const state = testable(collector).requests.get("active-budget");
		const retainedBeforeChunk = state?.retainedPayloadBytes ?? 0;
		expect(retainedBeforeChunk).toBe(Buffer.byteLength(requestBody));

		const nearCap = 100 * 1024 * 1024 - 1;
		testable(collector).activePayloadBytes = nearCap;
		collector.handleChunk("active-budget", modelBearingChunk());

		expect(state?.payloadReleased).toBe(true);
		expect(state?.startMessage.requestBody).toBeNull();
		expect(state?.startMessage.requestHeaders).toEqual({});
		expect(state?.chunks).toEqual([]);
		expect(state?.chunksBytes).toBe(0);
		expect(state?.retainedPayloadBytes).toBe(0);
		expect(testable(collector).activePayloadBytes).toBe(
			nearCap - retainedBeforeChunk,
		);
		expect(state?.usage.outputTokens).toBe(0);
		expect(payloadDrops).toHaveLength(1);
	});

	it("accounts active payload bytes through capture and prompt finalization release", async () => {
		const { collector } = harness(true);
		const requestBody = Buffer.from("accounted request").toString("base64");
		collector.handleStart(
			makeStartMessage("payload-accounting", { requestBody }),
		);
		const state = testable(collector).requests.get("payload-accounting");
		expect(testable(collector).activePayloadBytes).toBe(
			Buffer.byteLength(requestBody),
		);

		const chunk = new TextEncoder().encode(": ping\n\n");
		collector.handleChunk("payload-accounting", chunk);
		expect(state?.retainedPayloadBytes).toBe(
			Buffer.byteLength(requestBody) + chunk.byteLength,
		);
		expect(testable(collector).activePayloadBytes).toBe(
			Buffer.byteLength(requestBody) + chunk.byteLength,
		);

		await collector.handleEnd({
			type: "end",
			requestId: "payload-accounting",
			success: true,
		});
		expect(testable(collector).activePayloadBytes).toBe(0);
	});

	it("copies a captured chunk out of an oversized backing buffer", () => {
		const { collector } = harness(true);
		collector.handleStart(makeStartMessage("chunk-view-copy"));
		const encoded = modelBearingChunk();
		const backing = new Uint8Array(1024 * 1024);
		const offset = 127;
		backing.set(encoded, offset);
		const view = new Uint8Array(backing.buffer, offset, encoded.byteLength);

		collector.handleChunk("chunk-view-copy", view);

		const state = testable(collector).requests.get("chunk-view-copy");
		const stored = state?.chunks[0];
		expect(stored?.byteLength).toBe(view.byteLength);
		expect(stored?.buffer).not.toBe(backing.buffer);
		expect(stored?.buffer.byteLength).toBe(view.byteLength);
		expect(state?.chunksBytes).toBe(view.byteLength);
		expect(state?.retainedPayloadBytes).toBe(view.byteLength);
		expect(state?.usage.model).toBe("claude-sonnet-4-5-20250929");
		expect(state?.usage.outputTokens).toBe(0);
	});

	it("does not retain request bodies or chunks while payload storage is disabled", async () => {
		const { collector } = harness(false);
		const requestBody = Buffer.from("disabled payload").toString("base64");
		collector.handleStart(
			makeStartMessage("payload-disabled", {
				requestBody,
				requestHeaders: { "x-disabled": "true" },
			}),
		);
		const state = testable(collector).requests.get("payload-disabled");
		expect(state?.payloadReleased).toBe(true);
		expect(state?.startMessage.requestBody).toBeNull();
		expect(state?.startMessage.requestHeaders).toEqual({});
		expect(state?.retainedPayloadBytes).toBe(0);
		expect(testable(collector).activePayloadBytes).toBe(0);

		collector.handleChunk("payload-disabled", modelBearingChunk());
		expect(state?.chunks).toEqual([]);
		expect(state?.chunksBytes).toBe(0);
		expect(state?.usage.outputTokens).toBe(0);
		expect(testable(collector).activePayloadBytes).toBe(0);

		await collector.handleEnd({
			type: "end",
			requestId: "payload-disabled",
			success: true,
		});
	});

	it("retains the capacity safeguard and frees the oldest evicted state", () => {
		const { collector } = harness(true);
		const oldestBody = Buffer.from("oldest request").toString("base64");
		collector.handleStart(
			makeStartMessage("capacity-oldest", {
				requestBody: oldestBody,
				requestHeaders: { "x-oldest": "true" },
				responseHeaders: { "x-response": "oldest" },
			}),
		);
		collector.handleChunk(
			"capacity-oldest",
			new TextEncoder().encode("partial-event"),
		);
		const oldestState = testable(collector).requests.get("capacity-oldest");
		expect(oldestState).toBeDefined();
		expect(oldestState?.chunks.length).toBe(1);
		expect(oldestState?.buffer).toBe("partial-event");

		now += 1;
		for (let i = 0; i < 9_999; i++) {
			collector.handleStart(makeStartMessage(`capacity-filler-${i}`));
		}
		collector.handleStart(makeStartMessage("capacity-newest"));

		expect(testable(collector).requests.size).toBe(9_001);
		expect(testable(collector).requests.has("capacity-oldest")).toBe(false);
		expect(testable(collector).requests.has("capacity-newest")).toBe(true);
		expect(oldestState?.chunks).toEqual([]);
		expect(oldestState?.chunksBytes).toBe(0);
		expect(oldestState?.buffer).toBe("");
		expect(oldestState?.startMessage.requestBody).toBeNull();
		expect(oldestState?.startMessage.requestHeaders).toEqual({});
		expect(oldestState?.startMessage.responseHeaders).toEqual({});
	});

	it("warns only once for repeated chunks after state is missing", async () => {
		const { collector } = harness();
		const warnings: string[] = [];
		const onLog = (event: LogEvent) => {
			if (event.level === "WARN" && event.msg.includes("missing-stream")) {
				warnings.push(event.msg);
			}
		};
		logBus.on("log", onLog);

		try {
			for (let i = 0; i < 100; i++) {
				collector.handleChunk("missing-stream", new Uint8Array([i]));
			}
			await collector.handleEnd({
				type: "end",
				requestId: "missing-stream",
				success: false,
				error: "stream state was already evicted",
			});
		} finally {
			logBus.off("log", onLog);
		}

		expect(warnings).toHaveLength(1);
		expect(testable(collector).missingStateWarnings.size).toBe(1);
	});

	it("keeps exactly the newest 1000 missing-state warning tombstones in FIFO order", () => {
		const { collector } = harness();
		for (let i = 0; i < 1_100; i++) {
			collector.handleChunk(`unknown-${i}`, new Uint8Array([i % 256]));
		}

		const tombstones = testable(collector).missingStateWarnings;
		expect(tombstones.size).toBe(1_000);
		expect(tombstones.has("unknown-99")).toBe(false);
		expect(tombstones.has("unknown-100")).toBe(true);
		expect(tombstones.has("unknown-1099")).toBe(true);

		const warnings: string[] = [];
		const onLog = (event: LogEvent) => {
			if (event.level === "WARN" && event.msg.includes("unknown-")) {
				warnings.push(event.msg);
			}
		};
		logBus.on("log", onLog);
		try {
			collector.handleChunk("unknown-100", new Uint8Array([1]));
			collector.handleChunk("unknown-0", new Uint8Array([2]));
		} finally {
			logBus.off("log", onLog);
		}

		expect(warnings).toEqual(["No state found for request unknown-0"]);
	});

	it("resets missing-state warning eligibility when a request ID is reused", async () => {
		const { collector } = harness();
		const warnings: string[] = [];
		const onLog = (event: LogEvent) => {
			if (event.level === "WARN" && event.msg.includes("reused-warning-id")) {
				warnings.push(event.msg);
			}
		};
		logBus.on("log", onLog);

		try {
			collector.handleChunk("reused-warning-id", new Uint8Array([1]));
			collector.handleChunk("reused-warning-id", new Uint8Array([2]));
			collector.handleStart(makeStartMessage("reused-warning-id"));
			expect(
				testable(collector).missingStateWarnings.has("reused-warning-id"),
			).toBe(false);
			await collector.handleEnd({
				type: "end",
				requestId: "reused-warning-id",
				success: true,
			});
			collector.handleChunk("reused-warning-id", new Uint8Array([3]));
		} finally {
			logBus.off("log", onLog);
		}

		expect(warnings).toEqual([
			"No state found for request reused-warning-id",
			"No state found for request reused-warning-id",
		]);
	});
});
