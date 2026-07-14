/**
 * Tests for createRequestsSummaryHandler's attribution-source mapping (P2).
 *
 * Covers that project_attribution_source / agent_attribution_source columns
 * persisted via DatabaseOperations.saveRequest are read back and mapped onto
 * the RequestResponse fields the dashboard reads: projectAttributionSource
 * and agentAttributionSource (via the `as ProjectAttributionSource` /
 * `as AgentAttributionSource` casts in packages/http-api/src/handlers/requests.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { createRequestsSummaryHandler } from "../requests";

const TEST_DB_PATH = "/tmp/test-requests-summary-handler.db";

describe("createRequestsSummaryHandler — attribution source mapping", () => {
	let dbOps: DatabaseOperations;
	let handler: (limit?: number) => Promise<Response>;

	beforeAll(async () => {
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}

		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		handler = createRequestsSummaryHandler(dbOps.getAdapter());

		await dbOps.saveRequest(
			"req-attribution-1",
			"POST",
			"/v1/messages",
			null, // accountUsed
			200, // statusCode
			true, // success
			null, // errorMessage
			100, // responseTime
			0, // failoverAttempts
			undefined, // usage
			"bot", // agentUsed
			undefined, // apiKeyId
			undefined, // apiKeyName
			"acme", // project
			undefined, // billingType
			undefined, // comboName
			undefined, // originalModel
			undefined, // appliedModel
			"path_project", // projectAttributionSource
			"prompt_agent", // agentAttributionSource
		);
	});

	afterAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	it("maps project_attribution_source and agent_attribution_source onto the response", async () => {
		const response = await handler(50);
		expect(response.status).toBe(200);

		const body = (await response.json()) as RequestResponse[];
		const row = body.find((r) => r.id === "req-attribution-1");

		expect(row).toBeDefined();
		expect(row?.project).toBe("acme");
		expect(row?.projectAttributionSource).toBe("path_project");
		expect(row?.agentUsed).toBe("bot");
		expect(row?.agentAttributionSource).toBe("prompt_agent");
	});
});
