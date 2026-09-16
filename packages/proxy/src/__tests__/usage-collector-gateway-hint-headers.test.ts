/**
 * End-to-end tests for the "gateway hint" request headers flowing from a
 * `StartMessage`'s raw `requestHeaders` map through the real `UsageCollector`
 * onto the live-update `RequestResponse` summary.
 *
 * Mirrors usage-collector-stream-terminal-state.test.ts: drives the real
 * collector through a start->end cycle rather than asserting against the
 * extraction helper directly, so a regression in the wiring between
 * `msg.requestHeaders` and `state.gatewayHint`/the summary is caught even if
 * gateway-hint-headers.test.ts itself keeps passing. DB-level persistence
 * (the `requests` row) is covered separately in
 * packages/database/src/repositories/__tests__/request-gateway-hint-headers.test.ts.
 *
 * Backward compatibility is the point of this feature: the overwhelming
 * majority of requests carry none of these headers, and that must never
 * produce an error, a dropped request, or any other behavior change — every
 * field stays undefined, nothing else.
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
import type { EndMessage, StartMessage } from "../worker-messages";

const TEST_DB_PATH = "/tmp/test-usage-collector-gateway-hint-headers.db";

describe("UsageCollector - gateway hint headers in the live summary", () => {
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
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
		asyncWriter = new AsyncDbWriter();
		summaries = new Map();
		collector = new UsageCollector(
			dbOps,
			asyncWriter,
			() => false,
			(summary) => {
				summaries.set(summary.id, summary);
			},
		);
	});

	afterAll(async () => {
		collector.dispose();
		await collector.drain();
		DatabaseFactory.reset();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
	});

	function makeStart(
		requestId: string,
		requestHeaders: Record<string, string> = {},
	): StartMessage {
		return {
			type: "start",
			messageId: `msg-${requestId}`,
			requestId,
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders,
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
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
	}

	/**
	 * Drives a full start->end cycle through the REAL collector and returns
	 * the captured summary. Fails loudly if onSummary never fired, so a
	 * silently skipped request cannot produce a false pass.
	 */
	async function runRequestAndGetSummary(
		requestId: string,
		requestHeaders: Record<string, string>,
	): Promise<RequestResponse> {
		collector.handleStart(makeStart(requestId, requestHeaders));
		const endMsg: EndMessage = {
			type: "end",
			requestId,
			success: true,
		};
		await collector.handleEnd(endMsg);
		const summary = summaries.get(requestId);
		if (!summary) {
			throw new Error(
				`onSummary was not invoked for requestId=${requestId} — request may have been silently skipped`,
			);
		}
		return summary;
	}

	test("all five headers reach the live summary", async () => {
		const summary = await runRequestAndGetSummary("gateway-hint-full", {
			"x-claude-code-request-class": "primary",
			"x-claude-code-agent-type": "general-purpose",
			"x-claude-code-prev-tool-durations": "[120,340]",
			"x-claude-code-compaction": "auto",
			"x-claude-code-context-compacted": "true",
		});

		expect(summary.gatewayHintRequestClass).toBe("primary");
		expect(summary.gatewayHintAgentType).toBe("general-purpose");
		expect(summary.gatewayHintPrevToolDurations).toBe("[120,340]");
		expect(summary.gatewayHintCompaction).toBe("auto");
		expect(summary.gatewayHintContextCompacted).toBe("true");
	});

	test("a request with none of the headers is processed normally: fields stay undefined, nothing errors", async () => {
		const summary = await runRequestAndGetSummary(
			"gateway-hint-absent",
			{},
		);

		expect(summary.gatewayHintRequestClass).toBeUndefined();
		expect(summary.gatewayHintAgentType).toBeUndefined();
		expect(summary.gatewayHintPrevToolDurations).toBeUndefined();
		expect(summary.gatewayHintCompaction).toBeUndefined();
		expect(summary.gatewayHintContextCompacted).toBeUndefined();

		// The request itself must still succeed — a legacy client omitting
		// these headers is the overwhelmingly common case, not an edge case.
		expect(summary.success).toBe(true);
		expect(summary.statusCode).toBe(200);
	});

	test("a request with only one of the five headers leaves the rest undefined", async () => {
		const summary = await runRequestAndGetSummary("gateway-hint-partial", {
			"x-claude-code-agent-type": "subagent",
		});

		expect(summary.gatewayHintAgentType).toBe("subagent");
		expect(summary.gatewayHintRequestClass).toBeUndefined();
		expect(summary.gatewayHintPrevToolDurations).toBeUndefined();
		expect(summary.gatewayHintCompaction).toBeUndefined();
		expect(summary.gatewayHintContextCompacted).toBeUndefined();
	});

	test("headers arriving with mixed casing are still recognized (real HTTP headers are case-insensitive)", async () => {
		const summary = await runRequestAndGetSummary("gateway-hint-case", {
			"X-Claude-Code-Request-Class": "background",
		});

		expect(summary.gatewayHintRequestClass).toBe("background");
	});
});
