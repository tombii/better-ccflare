import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { isValidClaudeModel } from "../../../core/src/model-mappings";
import { CLAUDE_MODEL_IDS } from "../../../core/src/models";
import type { StartMessage } from "../worker-messages";

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
	saveRequestIds: string[];
	payloads: Map<string, string>;
	summaryCosts: Map<string, number | undefined>;
	summaries: string[];
}

interface TestRequestState {
	startMessage: StartMessage;
	buffer: string;
	chunks: Uint8Array[];
	chunksBytes: number;
}

interface TestableCollector {
	cleanupStaleRequests(): void;
	missingStateWarnings: Set<string>;
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
	const summaryCosts = new Map<string, number | undefined>();
	const summaries: string[] = [];
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
		},
		canAcceptPayload(): boolean {
			return true;
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

	return { collector, saveRequestIds, payloads, summaries, summaryCosts };
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

	it("detaches a finalizing stream before pricing yields so capacity eviction cannot free it", async () => {
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
		const stateSurvivedCapacityEviction =
			(finalizingState?.chunks.length ?? 0) > 0 &&
			finalizingState?.startMessage.requestBody === requestBody &&
			finalizingState?.startMessage.requestHeaders["x-lifecycle"] === "old";

		await endPromise;
		await collector.drain();

		const savedPayload = JSON.parse(
			payloads.get("finalizing-stream") ?? "null",
		);
		expect(detachedBeforePricingResolved).toBe(true);
		expect(stateSurvivedCapacityEviction).toBe(true);
		expect(savedPayload.request.body).toBe(requestBody);
		expect(savedPayload.request.headers).toEqual({ "x-lifecycle": "old" });
		expect(
			Buffer.from(savedPayload.response.body, "base64").toString("utf8"),
		).toContain("message_start");
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

	it("falls back to the default pricing deadline for an invalid override", () => {
		process.env.CF_PRICING_TIMEOUT_MS = "60001";
		const { collector } = harness();
		expect(testable(collector).pricingTimeoutMs).toBe(5_000);
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
