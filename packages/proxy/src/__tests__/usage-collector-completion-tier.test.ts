/**
 * `completion_tier` persistence: the tier the provider reports it actually ran
 * the request on (`usage.service_tier`, e.g. Sail Research "balanced") must
 * reach the stored `requests` row and the live summary. It is the APPLIED tier
 * only — when the provider says nothing the column stays NULL, with no
 * fallback to whatever tier the client asked for.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-usage-collector-completion-tier.db`;

function startMessage(requestId: string, isStream: boolean): StartMessage {
	return {
		type: "start",
		messageId: `msg-${requestId}`,
		requestId,
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: {},
		isStream,
		providerName: "sailresearch",
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
	};
}

/** SSE stream shaped like Sail Research: `service_tier` rides in `usage`. */
function sseBody(opts: { startTier?: unknown; deltaTier?: unknown }): string {
	const startUsage: Record<string, unknown> = {
		input_tokens: 31,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: 1,
	};
	if ("startTier" in opts) startUsage.service_tier = opts.startTier;
	const deltaUsage: Record<string, unknown> = { output_tokens: 16 };
	if ("deltaTier" in opts) deltaUsage.service_tier = opts.deltaTier;
	return [
		"event: message_start",
		`data: ${JSON.stringify({
			type: "message_start",
			message: { model: "sail-model", usage: startUsage },
		})}`,
		"",
		"event: content_block_start",
		`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		"",
		"event: content_block_delta",
		`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
		"",
		"event: message_delta",
		`data: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: deltaUsage,
		})}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
	].join("\n");
}

function jsonBody(usage?: Record<string, unknown>): string {
	return JSON.stringify({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "sail-model",
		content: [{ type: "text", text: "ok" }],
		...(usage ? { usage } : {}),
	});
}

describe("UsageCollector - completion_tier", () => {
	let dbOps: DatabaseOperations;
	let collector: UsageCollector;
	let summaries: Map<string, RequestResponse>;

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		summaries = new Map();
		collector = new UsageCollector(
			dbOps,
			new AsyncDbWriter(),
			() => true,
			(summary) => {
				summaries.set(summary.id, summary);
			},
		);
	});

	afterAll(async () => {
		collector.dispose();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
	});

	async function runStream(requestId: string, body: string) {
		collector.handleStart(startMessage(requestId, true));
		collector.handleChunk(
			requestId,
			new Uint8Array(Buffer.from(body, "utf-8")),
		);
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: null,
		});
		await collector.drain();
	}

	async function runJson(requestId: string, body: string) {
		collector.handleStart(startMessage(requestId, false));
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: Buffer.from(body).toString("base64"),
		});
		await collector.drain();
	}

	async function storedTier(requestId: string): Promise<string | null> {
		const rows = await dbOps
			.getAdapter()
			.query<{ completion_tier: string | null }>(
				"SELECT completion_tier FROM requests WHERE id = ?",
				[requestId],
			);
		return rows[0]?.completion_tier ?? null;
	}

	test("captures service_tier from a message_start frame", async () => {
		await runStream(
			"tier-1-start",
			sseBody({ startTier: "balanced", deltaTier: undefined }),
		);
		expect(await storedTier("tier-1-start")).toBe("balanced");
		expect(summaries.get("tier-1-start")?.completionTier).toBe("balanced");
	});

	test("captures service_tier from a message_delta frame", async () => {
		await runStream("tier-2-delta", sseBody({ deltaTier: "priority" }));
		expect(await storedTier("tier-2-delta")).toBe("priority");
		expect(summaries.get("tier-2-delta")?.completionTier).toBe("priority");
	});

	test("captures service_tier from a non-stream JSON body", async () => {
		await runJson(
			"tier-3-json",
			jsonBody({ input_tokens: 31, output_tokens: 16, service_tier: "flex" }),
		);
		expect(await storedTier("tier-3-json")).toBe("flex");
		expect(summaries.get("tier-3-json")?.completionTier).toBe("flex");
	});

	test("leaves completion_tier NULL when the provider reports nothing", async () => {
		await runStream("tier-4-absent", sseBody({}));
		expect(await storedTier("tier-4-absent")).toBeNull();
		expect(summaries.get("tier-4-absent")?.completionTier).toBeUndefined();

		await runJson("tier-5-absent-json", jsonBody({ output_tokens: 3 }));
		expect(await storedTier("tier-5-absent-json")).toBeNull();
		expect(summaries.get("tier-5-absent-json")?.completionTier).toBeUndefined();
	});

	test("ignores non-string and empty service_tier values", async () => {
		await runStream(
			"tier-6-number",
			sseBody({ startTier: 42, deltaTier: { tier: "x" } }),
		);
		expect(await storedTier("tier-6-number")).toBeNull();
		expect(summaries.get("tier-6-number")?.completionTier).toBeUndefined();

		await runStream("tier-7-empty", sseBody({ startTier: "", deltaTier: "" }));
		expect(await storedTier("tier-7-empty")).toBeNull();
		expect(summaries.get("tier-7-empty")?.completionTier).toBeUndefined();

		await runJson(
			"tier-8-number-json",
			jsonBody({ output_tokens: 3, service_tier: 7 }),
		);
		expect(await storedTier("tier-8-number-json")).toBeNull();
		expect(summaries.get("tier-8-number-json")?.completionTier).toBeUndefined();
	});
});
