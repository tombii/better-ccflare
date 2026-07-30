/**
 * End-to-end tests for propagating `EndMessage.streamTerminalState` onto the
 * `RequestResponse` summary emitted via `onSummary`
 * (packages/proxy/src/usage-collector.ts).
 *
 * The collector already persisted the value into the `stream_terminal_state`
 * column, but dropped it when building the real-time summary. That made the
 * live dashboard stream and a later /api/requests fetch disagree about the
 * same request: the row gained its terminal state only after a reload. These
 * tests pin both surfaces to the same value.
 *
 * The state itself is produced by the SSE observer in
 * packages/proxy/src/anthropic-terminal-recovery.ts.
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

const TEST_DB_PATH = "/tmp/test-usage-collector-stream-terminal-state.db";

describe("UsageCollector - stream terminal state in the live summary", () => {
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

	function makeStart(requestId: string): StartMessage {
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
			isStream: true,
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
	 * Drives a full start->end cycle through the REAL collector and returns the
	 * captured summary. Fails loudly if onSummary never fired, so a silently
	 * skipped request cannot produce a false pass.
	 */
	async function runRequestAndGetSummary(
		requestId: string,
		streamTerminalState: EndMessage["streamTerminalState"],
	): Promise<RequestResponse> {
		collector.handleStart(makeStart(requestId));
		const endMsg: EndMessage = {
			type: "end",
			requestId,
			success: true,
			streamTerminalState,
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

	test("a client-cancelled stream reaches the live summary", async () => {
		const summary = await runRequestAndGetSummary(
			"terminal-state-cancelled",
			"client_cancelled",
		);

		expect(summary.streamTerminalState).toBe("client_cancelled");
		// The header status stays 200 — that is precisely why the separate
		// terminal state is needed to spot an incomplete response.
		expect(summary.statusCode).toBe(200);
	});

	test("a truncated stream reaches the live summary", async () => {
		const summary = await runRequestAndGetSummary(
			"terminal-state-truncated",
			"truncated",
		);

		expect(summary.streamTerminalState).toBe("truncated");
	});

	test("the field stays undefined when the stream reported no terminal state", async () => {
		const summary = await runRequestAndGetSummary(
			"terminal-state-absent",
			undefined,
		);

		expect(summary.streamTerminalState).toBeUndefined();
	});

	test("a null terminal state is normalised to undefined, not forwarded as null", async () => {
		const summary = await runRequestAndGetSummary("terminal-state-null", null);

		expect(summary.streamTerminalState).toBeUndefined();
	});
});
