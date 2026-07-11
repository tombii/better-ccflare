/**
 * P2 regression test: RequestPayload.meta must carry projectAttributionSource
 * alongside meta.project (packages/types/src/request.ts), and the
 * UsageCollector must actually serialize it (packages/proxy/src/usage-collector.ts).
 *
 * Before this fix, `meta.project` was persisted but its provenance source was
 * dropped, so `/api/requests/payload/:id` and the dashboard's Copy-as-JSON
 * exposed a project name with no way to tell whether it came from a header,
 * a workspace path, or a heading.
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

const TEST_DB_PATH = "/tmp/test-usage-collector-payload-meta.db";

describe("UsageCollector - RequestPayload.meta includes projectAttributionSource (P2)", () => {
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
			() => true, // store payloads — required for meta persistence
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
			console.warn("Failed to clean up test database:", error);
		}
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
			...overrides,
		};
	}

	test("persists meta.project and meta.projectAttributionSource together in the stored payload", async () => {
		const requestId = "payload-meta-1-authoritative-value";
		const start = makeStart({
			requestId,
			project: "foo",
			projectAttributionSource: "path_project",
		});

		collector.handleStart(start);
		const endMsg: EndMessage = { type: "end", requestId, success: true };
		await collector.handleEnd(endMsg);
		await collector.drain();

		const summary = summaries.get(requestId);
		if (!summary) {
			throw new Error(`onSummary was not invoked for requestId=${requestId}`);
		}
		expect(summary.project).toBe("foo");
		expect(summary.projectAttributionSource).toBe("path_project");

		const payload = (await dbOps.getRequestPayload(requestId)) as {
			meta?: { project?: string; projectAttributionSource?: string };
		} | null;
		expect(payload).not.toBeNull();
		expect(payload?.meta?.project).toBe("foo");
		expect(payload?.meta?.projectAttributionSource).toBe("path_project");
	});

	test('persists meta.projectAttributionSource "none" when there is no project', async () => {
		const requestId = "payload-meta-2-none";
		const start = makeStart({
			requestId,
			project: null,
			projectAttributionSource: "none",
		});

		collector.handleStart(start);
		const endMsg: EndMessage = { type: "end", requestId, success: true };
		await collector.handleEnd(endMsg);
		await collector.drain();

		const payload = (await dbOps.getRequestPayload(requestId)) as {
			meta?: { project?: string; projectAttributionSource?: string };
		} | null;
		expect(payload).not.toBeNull();
		expect(payload?.meta?.project).toBeUndefined();
		expect(payload?.meta?.projectAttributionSource).toBe("none");
	});
});
