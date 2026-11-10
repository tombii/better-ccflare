/**
 * The live SSE summary must carry the provider's peak state, because the
 * Requests tab badges a request as "Peak" from that summary alone — the list
 * view never loads payloads. The collector takes the provider name from the
 * start message, so no database lookup is needed on this path.
 *
 * A summary that disagreed with the REST endpoint (createRequestsSummaryHandler)
 * would make the badge flicker: correct after a reload, wrong on the live tick.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { resetChineseHolidayCache } from "../chinese-holidays";
import { UsageCollector } from "../usage-collector";
import type { EndMessage, StartMessage } from "../worker-messages";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-usage-collector-peak-hours.db`;

// Reference calendar (2026-09, UTC): 23 Wed.
const WED_PEAK_MS = Date.UTC(2026, 8, 23, 2, 0); // DeepSeek window 1
const WED_OFFPEAK_MS = Date.UTC(2026, 8, 23, 12, 0);

describe("UsageCollector - live summary carries peakHours", () => {
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;
	let summaries: Map<string, RequestResponse>;

	beforeAll(async () => {
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
			() => false, // no payloads needed — the summary is the subject
			(summary) => {
				summaries.set(summary.id, summary);
			},
		);
	});

	afterAll(async () => {
		collector.dispose();
		resetChineseHolidayCache();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.reset();
	});

	function makeStart(
		overrides: Partial<StartMessage> & { requestId: string },
	): StartMessage {
		return {
			type: "start",
			messageId: `msg-${overrides.requestId}`,
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
			providerName: "deepseek",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: "ds",
			agentUsed: null,
			comboName: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
			...overrides,
		};
	}

	async function run(
		start: StartMessage,
	): Promise<RequestResponse | undefined> {
		collector.handleStart(start);
		const endMsg: EndMessage = {
			type: "end",
			requestId: start.requestId,
			success: true,
		};
		await collector.handleEnd(endMsg);
		await collector.drain();
		return summaries.get(start.requestId);
	}

	test("reports the provider's peak state at the request's timestamp", async () => {
		const peak = await run(
			makeStart({
				requestId: "peak-1-inside-window",
				accountId: "acct-ds",
				timestamp: WED_PEAK_MS,
			}),
		);
		expect(peak?.peakHours).toEqual({ active: true });

		const offPeak = await run(
			makeStart({
				requestId: "peak-2-outside-window",
				accountId: "acct-ds",
				timestamp: WED_OFFPEAK_MS,
			}),
		);
		expect(offPeak?.peakHours).toEqual({ active: false });
	});

	test("is null for providers without a peak concept", async () => {
		const summary = await run(
			makeStart({
				requestId: "peak-3-codex",
				accountId: "acct-codex",
				providerName: "codex",
				accountName: "cx",
				timestamp: WED_PEAK_MS,
			}),
		);
		expect(summary?.peakHours).toBeNull();
	});

	test("is null when the request has no account", async () => {
		// No account means no account provider to price against, even though a
		// provider may still have been tried.
		const summary = await run(
			makeStart({
				requestId: "peak-4-no-account",
				accountId: null,
				timestamp: WED_PEAK_MS,
			}),
		);
		expect(summary?.peakHours).toBeNull();
	});
});
