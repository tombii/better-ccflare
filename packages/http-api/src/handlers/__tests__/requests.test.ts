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
import { getPeakHoursState } from "@better-ccflare/proxy";
import type { RequestResponse } from "@better-ccflare/types";
import { createRequestsSummaryHandler } from "../requests";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-requests-summary-handler.db`;

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

		handler = createRequestsSummaryHandler(
			dbOps.getAdapter(),
			getPeakHoursState,
		);

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

		// Regression coverage for the persisted-badges bug: gateway_hint_* columns
		// were readable from the DB but not mapped onto RequestResponse here, so
		// they appeared in live collector updates and vanished after a dashboard
		// reload (which re-fetches this summary endpoint).
		await dbOps.saveRequest(
			"req-gateway-hint-1",
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
			undefined, // projectAttributionSource
			undefined, // agentAttributionSource
			undefined, // streamTerminalState
			undefined, // clientSessionId
			"agent", // gatewayHintRequestClass
			"explore", // gatewayHintAgentType
			"[1200,340]", // gatewayHintPrevToolDurations
			"none", // gatewayHintCompaction
			"false", // gatewayHintContextCompacted
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

	it("maps the gateway_hint_* columns onto the response", async () => {
		const response = await handler(50);
		expect(response.status).toBe(200);

		const body = (await response.json()) as RequestResponse[];
		const row = body.find((r) => r.id === "req-gateway-hint-1");

		expect(row).toBeDefined();
		expect(row?.gatewayHintRequestClass).toBe("agent");
		expect(row?.gatewayHintAgentType).toBe("explore");
		expect(row?.gatewayHintPrevToolDurations).toBe("[1200,340]");
		expect(row?.gatewayHintCompaction).toBe("none");
		expect(row?.gatewayHintContextCompacted).toBe("false");
	});
});

/**
 * The Requests tab badges a request as "Peak" from the summary alone (the
 * list view never loads payloads). The provider that decides which peak rule
 * applies lives on `accounts`, not on `requests`, and DeepSeek's rule needs
 * the Chinese holiday calendar — so the server resolves both here rather
 * than leaving the dashboard to guess.
 */
describe("createRequestsSummaryHandler — peak hours", () => {
	const PEAK_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-requests-summary-peak.db`;
	let dbOps: DatabaseOperations;
	let handler: (limit?: number) => Promise<Response>;

	// Reference calendar (2026-09, UTC): 23 Wed, 26 Sat.
	const WED_PEAK_MS = Date.UTC(2026, 8, 23, 2, 0); // DeepSeek window 1
	const WED_OFFPEAK_MS = Date.UTC(2026, 8, 23, 12, 0);

	beforeAll(async () => {
		try {
			if (existsSync(PEAK_DB_PATH)) {
				unlinkSync(PEAK_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}

		DatabaseFactory.initialize(PEAK_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createRequestsSummaryHandler(
			dbOps.getAdapter(),
			getPeakHoursState,
		);

		for (const [id, name, provider] of [
			["acct-ds", "ds", "deepseek"],
			["acct-zai", "zai", "zai"],
			["acct-codex", "cx", "codex"],
		]) {
			await dbOps.getAdapter().run(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[id, name, provider, "r", "a", Date.now() + 3_600_000, Date.now()],
			);
		}

		for (const [id, accountUsed] of [
			["req-ds-peak", "acct-ds"],
			["req-ds-offpeak", "acct-ds"],
			["req-zai", "acct-zai"],
			["req-codex", "acct-codex"],
			["req-no-account", null],
		] as const) {
			await dbOps.saveRequest(
				id,
				"POST",
				"/v1/messages",
				accountUsed,
				200,
				true,
				null,
				100,
				0,
			);
		}

		// saveRequest stamps the row with "now"; pin the timestamps afterwards so
		// the peak decision is deterministic rather than dependent on the clock.
		for (const [id, ts] of [
			["req-ds-peak", WED_PEAK_MS],
			["req-ds-offpeak", WED_OFFPEAK_MS],
			["req-zai", WED_PEAK_MS],
			["req-codex", WED_PEAK_MS],
			["req-no-account", WED_PEAK_MS],
		] as const) {
			await dbOps
				.getAdapter()
				.run("UPDATE requests SET timestamp = ? WHERE id = ?", [ts, id]);
		}
	});

	afterAll(() => {
		try {
			if (existsSync(PEAK_DB_PATH)) {
				unlinkSync(PEAK_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	async function byId(): Promise<Map<string, RequestResponse>> {
		const response = await handler(50);
		expect(response.status).toBe(200);
		const body = (await response.json()) as RequestResponse[];
		return new Map(body.map((r) => [r.id, r]));
	}

	it("reports the provider's peak state at the request's own timestamp", async () => {
		const rows = await byId();
		expect(rows.get("req-ds-peak")?.peakHours).toEqual({ active: true });
		expect(rows.get("req-ds-offpeak")?.peakHours).toEqual({ active: false });
		// Wed 02:00 UTC is outside Zai's 14:00-18:00 SGT window.
		expect(rows.get("req-zai")?.peakHours).toEqual({ active: false });
	});

	it("returns null for providers without a peak concept and for unattributed requests", async () => {
		const rows = await byId();
		expect(rows.get("req-codex")?.peakHours).toBeNull();
		expect(rows.get("req-no-account")?.peakHours).toBeNull();
	});
});
