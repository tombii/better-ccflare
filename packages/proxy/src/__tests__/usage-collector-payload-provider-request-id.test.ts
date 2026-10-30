/**
 * The upstream provider's per-request id (e.g. NanoGPT `x-request-id`) must
 * reach the stored request payload's `meta.providerRequestId` so the dashboard
 * Response tab can show it — and must stay absent for providers without one,
 * so existing payloads keep their shape.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { providerRequestIdFromHeaders } from "@better-ccflare/providers";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-usage-collector-payload-provider-request-id.db`;

describe("UsageCollector - RequestPayload.meta.providerRequestId", () => {
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		asyncWriter = new AsyncDbWriter();
		collector = new UsageCollector(
			dbOps,
			asyncWriter,
			() => true,
			() => {},
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

	async function run(start: StartMessage) {
		collector.handleStart(start);
		await collector.handleEnd({
			type: "end",
			requestId: start.requestId,
			success: true,
		});
		await collector.drain();
		return (await dbOps.getRequestPayload(start.requestId)) as {
			meta?: { providerRequestId?: string };
		} | null;
	}

	test("persists providerRequestId set from the nanogpt response headers", async () => {
		const headers = new Headers({ "x-request-id": "req_xyz789" });
		const payload = await run(
			makeStart({
				requestId: "provider-request-id-1-nanogpt",
				providerName: "nanogpt",
				responseHeaders: Object.fromEntries(headers.entries()),
				providerRequestId: providerRequestIdFromHeaders("nanogpt", headers),
			}),
		);
		expect(payload?.meta?.providerRequestId).toBe("req_xyz789");
	});

	test("omits providerRequestId when the provider has none", async () => {
		const headers = new Headers({ "x-request-id": "req_xyz789" });
		const payload = await run(
			makeStart({
				requestId: "provider-request-id-2-anthropic",
				providerName: "anthropic",
				responseHeaders: Object.fromEntries(headers.entries()),
				providerRequestId: providerRequestIdFromHeaders("anthropic", headers),
			}),
		);
		expect(payload).not.toBeNull();
		expect(payload?.meta).not.toHaveProperty("providerRequestId");
	});

	test("omits providerRequestId when the StartMessage field is an explicit null", async () => {
		const payload = await run(
			makeStart({
				requestId: "provider-request-id-3-explicit-null",
				providerName: "anthropic",
				providerRequestId: null,
			}),
		);
		expect(payload).not.toBeNull();
		expect(payload?.meta).not.toHaveProperty("providerRequestId");
	});
});
