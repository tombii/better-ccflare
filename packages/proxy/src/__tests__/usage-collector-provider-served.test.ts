/**
 * `provider_served` persistence: the backend the provider's own response body
 * names (OpenRouter `provider`) must reach the stored `requests` row and the
 * /api/requests mapping, and must stay NULL for providers that do not state it.
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

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-usage-collector-provider-served.db`;

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

describe("UsageCollector - provider_served", () => {
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

	async function run(requestId: string, providerName: string) {
		const start: StartMessage = {
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
		collector.handleStart(start);
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: Buffer.from(OPENROUTER_BODY).toString("base64"),
		});
		await collector.drain();
		return requestId;
	}

	test("stores the openrouter serving provider on the request row and summary", async () => {
		const requestId = await run("provider-served-1-openrouter", "openrouter");

		const rows = await dbOps
			.getAdapter()
			.query<{ provider_served: string | null }>(
				"SELECT provider_served FROM requests WHERE id = ?",
				[requestId],
			);
		expect(rows[0]?.provider_served).toBe("Morph");
		expect(summaries.get(requestId)?.providerServed).toBe("Morph");
	});

	test("leaves provider_served NULL for providers that do not state it", async () => {
		const requestId = await run("provider-served-2-nanogpt", "nanogpt");

		const rows = await dbOps
			.getAdapter()
			.query<{ provider_served: string | null }>(
				"SELECT provider_served FROM requests WHERE id = ?",
				[requestId],
			);
		expect(rows[0]?.provider_served).toBeNull();
		expect(summaries.get(requestId)?.providerServed).toBeUndefined();
	});

	test("updateUsage fills provider_served after the row exists", async () => {
		const requestId = "provider-served-3-late";
		await dbOps.saveRequest(
			requestId,
			"POST",
			"/v1/messages",
			null,
			200,
			true,
			null,
			10,
			0,
		);
		await dbOps.updateRequestUsage(requestId, {
			model: "deepseek/deepseek-v4.1-flash-1017",
			providerServed: "Morph",
		});
		// A later update without the field must not blank it out (COALESCE).
		await dbOps.updateRequestUsage(requestId, { promptTokens: 3 });

		const rows = await dbOps
			.getAdapter()
			.query<{ provider_served: string | null }>(
				"SELECT provider_served FROM requests WHERE id = ?",
				[requestId],
			);
		expect(rows[0]?.provider_served).toBe("Morph");
	});
});
