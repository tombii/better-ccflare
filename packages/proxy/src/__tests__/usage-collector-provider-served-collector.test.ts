/**
 * `provider_served` must not depend on the order in which two independent
 * background jobs finish: the response processor discovers the serving backend
 * as soon as the body arrives, while the UsageCollector only INSERTs the
 * requests row when handleEnd runs (response fully delivered to the client).
 * A separate UPDATE racing the INSERT loses the label on a slow client, and a
 * response body over the collector's 256 KB cap cannot be re-parsed at all.
 *
 * The collector state is therefore seeded with the label before (or handed to
 * it after) the row is written. These tests pin both orderings and the
 * truncated-body case, plus the fallback for a row the collector no longer
 * tracks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import {
	recordDiscoveredProviderServed,
	UsageCollector,
} from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-usage-collector-provider-served-collector.db`;

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

/**
 * SSE fixture shaped like an OpenRouter /v1/messages stream: the serving
 * backend is named on the terminal message_delta, after 300 KB of content —
 * past the collector's 256 KB capture cap, so the stored chunks are truncated
 * and cannot be re-parsed after the fact.
 */
function sseBody(provider?: string): string {
	const filler = "x".repeat(300 * 1024);
	const delta = JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		...(provider ? { provider } : {}),
		usage: { input_tokens: 10, output_tokens: 2 },
	});
	return [
		`event: message_start`,
		`data: ${JSON.stringify({ type: "message_start", message: { model: "deepseek/deepseek-v4.1-flash-1017", usage: { input_tokens: 10, output_tokens: 1 } } })}`,
		``,
		`event: content_block_delta`,
		`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: filler } })}`,
		``,
		`event: message_delta`,
		`data: ${delta}`,
		``,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		``,
	].join("\n");
}

describe("UsageCollector - provider_served seeded before the row exists", () => {
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

	function start(requestId: string, providerName: string): void {
		const message: StartMessage = {
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
			isStream: false,
			providerName,
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
		collector.handleStart(message);
	}

	async function providerServedOf(requestId: string): Promise<string | null> {
		const rows = await dbOps
			.getAdapter()
			.query<{ provider_served: string | null }>(
				"SELECT provider_served FROM requests WHERE id = ?",
				[requestId],
			);
		return rows[0]?.provider_served ?? null;
	}

	test("label handed to the collector state before handleEnd lands on the inserted row", async () => {
		const requestId = "served-seeded-before-end";
		start(requestId, "openrouter");
		expect(collector.setProviderServed(requestId, "Morph")).toBe(true);

		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: Buffer.from(OPENROUTER_BODY).toString("base64"),
		});
		await collector.drain();

		expect(await providerServedOf(requestId)).toBe("Morph");
		expect(summaries.get(requestId)?.providerServed).toBe("Morph");
	});

	test("streamed body past the capture cap still records the label (SSE provider field)", async () => {
		const requestId = "served-truncated-stream";
		start(requestId, "openrouter");
		// Delivered the way a real stream arrives: message_start early, the big
		// content delta later. Total capture passes the 256 KB cap, so the
		// stored chunks are truncated and the label must come from the SSE
		// frames the collector parsed live, not from re-parsing the payload.
		const whole = sseBody("Morph");
		const contentAt = whole.indexOf("event: content_block_delta");
		const deltaAt = whole.indexOf("event: message_delta");
		const encoder = new TextEncoder();
		// message_start (small, parsed immediately), then the 300 KB content
		// delta, then the terminal message_delta naming the backend.
		collector.handleChunk(requestId, encoder.encode(whole.slice(0, contentAt)));
		collector.handleChunk(
			requestId,
			encoder.encode(whole.slice(contentAt, deltaAt)),
		);
		collector.handleChunk(requestId, encoder.encode(whole.slice(deltaAt)));
		const state = (
			collector as unknown as {
				requests: Map<
					string,
					{ chunksTruncated: boolean; chunksBytes: number }
				>;
			}
		).requests.get(requestId);
		// Capture stopped at the 256 KB cap: the stored payload cannot be re-parsed.
		expect(state?.chunksTruncated).toBe(true);
		expect(state?.chunksBytes).toBe(256 * 1024);

		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: null,
		});
		await collector.drain();

		expect(await providerServedOf(requestId)).toBe("Morph");
		expect(summaries.get(requestId)?.providerServed).toBe("Morph");
	});

	test("a label carried by a frame with no usage is still recorded", async () => {
		const requestId = "served-label-only-frame";
		start(requestId, "openrouter");
		const encoder = new TextEncoder();
		collector.handleChunk(
			requestId,
			encoder.encode(
				[
					"event: message_start",
					`data: ${JSON.stringify({ type: "message_start", message: { model: "deepseek/deepseek-v4.1-flash-1017", usage: { input_tokens: 10, output_tokens: 1 } } })}`,
					"",
					"event: message_final",
					`data: ${JSON.stringify({ type: "message_final", provider: "Morph" })}`,
					"",
				].join("\n"),
			),
		);

		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: null,
		});
		await collector.drain();

		expect(await providerServedOf(requestId)).toBe("Morph");
	});

	test("a provider that does not state a backend records nothing from the stream", async () => {
		const requestId = "served-stream-nanogpt";
		start(requestId, "nanogpt");
		collector.handleChunk(
			requestId,
			new TextEncoder().encode(sseBody("Morph")),
		);

		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: null,
		});
		await collector.drain();

		expect(await providerServedOf(requestId)).toBeNull();
		expect(summaries.get(requestId)?.providerServed).toBeUndefined();
	});

	test("a seeded label for a row the collector does not track does not override the body", async () => {
		const requestId = "served-seeded-untracked";
		// No handleStart: there is no collector state for this id.
		expect(collector.setProviderServed(requestId, "Morph")).toBe(false);

		start(requestId, "nanogpt");
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: Buffer.from(OPENROUTER_BODY).toString("base64"),
		});
		await collector.drain();

		expect(await providerServedOf(requestId)).toBeNull();
		expect(summaries.get(requestId)?.providerServed).toBeUndefined();
	});
});

describe("recordDiscoveredProviderServed - late discovery", () => {
	async function makeCollector() {
		const saves: Array<{
			id: string;
			state: Record<string, unknown> | undefined;
		}> = [];
		const writer = new AsyncDbWriter();
		const collector = new UsageCollector(
			{
				saveRequest: async (id: string, ...rest: unknown[]) => {
					saves.push({
						id,
						state: rest[8] as Record<string, unknown> | undefined,
					});
				},
				updateAccountUsage: async () => {},
			} as never,
			writer,
			() => false,
			() => {},
		);
		const start = (requestId: string, providerName: string) =>
			collector.handleStart({
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
				isStream: false,
				providerName,
				accountBillingType: null,
				accountAutoPauseOnOverageEnabled: null,
				accountName: null,
				agentUsed: null,
				comboName: null,
				apiKeyId: null,
				apiKeyName: null,
				retryAttempt: 0,
				failoverAttempts: 0,
			} as StartMessage);
		return { collector, writer, saves, start };
	}

	test("after the body ended, the label falls through to the DB update", async () => {
		const { collector, writer, start } = await makeCollector();
		const updates: Array<[string, string]> = [];
		start("served-late", "openrouter");
		await collector.handleEnd({
			type: "end",
			requestId: "served-late",
			success: true,
			responseBody: Buffer.from(OPENROUTER_BODY).toString("base64"),
		});
		await writer.dispose();

		const handled = await recordDiscoveredProviderServed(
			collector,
			"served-late",
			"Morph",
			async (id, served) => {
				updates.push([id, served]);
			},
		);
		collector.dispose();

		expect(handled).toBe(true);
		expect(updates).toEqual([["served-late", "Morph"]]);
	});

	test("before the body ended, the label is stashed on the collector state instead", async () => {
		const { collector, writer, start } = await makeCollector();
		const updates: Array<[string, string]> = [];
		start("served-early", "openrouter");

		const handled = await recordDiscoveredProviderServed(
			collector,
			"served-early",
			"Morph",
			async (id, served) => {
				updates.push([id, served]);
			},
		);
		await collector.handleEnd({
			type: "end",
			requestId: "served-early",
			success: true,
			responseBody: null,
		});
		await writer.dispose();
		collector.dispose();

		expect(handled).toBe(true);
		expect(updates).toEqual([]);
	});

	test("a failing fallback write reports the value as unhandled", async () => {
		const handled = await recordDiscoveredProviderServed(
			null,
			"served-fail",
			"Morph",
			async () => {
				throw new Error("db down");
			},
		);
		expect(handled).toBe(false);
	});

	test("with no collector, it writes the row directly", async () => {
		const updates: Array<[string, string]> = [];
		const handled = await recordDiscoveredProviderServed(
			null,
			"served-none",
			"Morph",
			async (id, served) => {
				updates.push([id, served]);
			},
		);
		expect(handled).toBe(true);
		expect(updates).toEqual([["served-none", "Morph"]]);
	});
});

describe("UsageCollector - provider_served from a non-stream body", () => {
	test("records the openrouter serving provider", async () => {
		const saved: Array<Record<string, unknown> | undefined> = [];
		const summaries: Array<{ providerServed?: string }> = [];
		const collector = new UsageCollector(
			{
				saveRequest: async (_id: string, ...rest: unknown[]) => {
					saved.push(rest[8] as Record<string, unknown> | undefined);
				},
				updateAccountUsage: async () => {},
			} as never,
			{
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
		collector.handleStart({
			type: "start",
			messageId: "m",
			requestId: "served-inline",
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
		} as StartMessage);
		await collector.handleEnd({
			type: "end",
			requestId: "served-inline",
			success: true,
			responseBody: Buffer.from(OPENROUTER_BODY).toString("base64"),
		});
		collector.dispose();

		expect(saved[0]).toMatchObject({ providerServed: "Morph" });
		expect(summaries[0]?.providerServed).toBe("Morph");
	});
});
