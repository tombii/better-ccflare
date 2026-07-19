/**
 * End-to-end tests for the tri-state project/agent attribution-source
 * contract implemented in `UsageCollector.handleStart`
 * (packages/proxy/src/usage-collector.ts).
 *
 * The only prior coverage of this branching (in
 * response-handler-worker-protocol.test.ts) exercised a MOCK collector whose
 * handleStart just pushed the raw input message onto an array — it asserted
 * on the input, never on real branching logic. These tests instantiate the
 * real `UsageCollector` against a temp SQLite DB and assert on the
 * `RequestResponse` summary emitted via `onSummary`, which is populated from
 * the collector's internal `RequestState` after `handleStart` has run its
 * branching logic.
 *
 * Tri-state contract (usage-collector.ts handleStart, ~lines 377-394):
 *  (A) msg.projectAttributionSource != null -> authoritative, used as-is,
 *      no recomputation (covers both a concrete value and "none").
 *  (B) msg.project set but no source -> legacy, tagged "none".
 *  (C) neither project nor source -> fully legacy/direct, recomputed via
 *      extractProjectAttributionFromParts.
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

const TEST_DB_PATH = "/tmp/test-usage-collector-attribution-tristate.db";

describe("UsageCollector - attribution tri-state (real collector, end-to-end)", () => {
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

	function base64Body(body: unknown): string {
		return Buffer.from(JSON.stringify(body)).toString("base64");
	}

	/**
	 * Drives a full start->end cycle through the REAL collector and returns
	 * the captured summary. Awaiting the Promise returned by handleEnd is
	 * sufficient: _handleEndInternal builds and emits the summary
	 * synchronously (no model usage was recorded in these fixtures, so the
	 * `await estimateCostUSD(...)` branch never executes) before that
	 * promise settles — there is no async gap between "end processed" and
	 * "onSummary fired" to race. Fails loudly if onSummary never fired, so a
	 * silently-skipped request (e.g. shouldLogRequest returning false)
	 * cannot produce a false pass.
	 */
	async function runRequestAndGetSummary(
		start: StartMessage,
	): Promise<RequestResponse> {
		collector.handleStart(start);
		const endMsg: EndMessage = {
			type: "end",
			requestId: start.requestId,
			success: true,
		};
		await collector.handleEnd(endMsg);
		const summary = summaries.get(start.requestId);
		if (!summary) {
			throw new Error(
				`onSummary was not invoked for requestId=${start.requestId} — request may have been silently skipped`,
			);
		}
		return summary;
	}

	test("branch A: authoritative project + source are used as-is, without recomputation", async () => {
		const start = makeStart({
			requestId: "tristate-1-authoritative-value",
			project: "foo",
			projectAttributionSource: "path_project",
			agentUsed: "agent-x",
			agentAttributionSource: "header_agent",
			// System prompt contains a DIFFERENT workspace path. If the
			// collector recomputed instead of honoring the authoritative
			// source, project would become "otherrepo" / path_project would
			// be recomputed (still path_project, but for the wrong project).
			requestBody: base64Body({
				system: "context at /home/u/projects/otherrepo/x.ts done",
			}),
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.project).toBe("foo");
		expect(summary.projectAttributionSource).toBe("path_project");
		expect(summary.agentAttributionSource).toBe("header_agent");
	});

	test('branch A: authoritative "none" suppresses recomputation even with a matching path in the body', async () => {
		const start = makeStart({
			requestId: "tristate-2-authoritative-none",
			project: null,
			projectAttributionSource: "none",
			agentUsed: null,
			agentAttributionSource: "none",
			// Recognizable workspace path present — must NOT be picked up,
			// because the authoritative source is "none".
			requestBody: base64Body({
				system: "context at /home/u/projects/shouldnotmatch/x.ts done",
			}),
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.projectAttributionSource).toBe("none");
		expect(summary.project == null).toBe(true);
	});

	test('branch B: legacy project without a source is tagged "none"', async () => {
		const start = makeStart({
			requestId: "tristate-3-legacy-project",
			project: "bar",
			// projectAttributionSource and agentAttributionSource intentionally omitted.
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.project).toBe("bar");
		expect(summary.projectAttributionSource).toBe("none");
	});

	test("branch C: fully legacy/direct request recomputes via the shared helper", async () => {
		const start = makeStart({
			requestId: "tristate-4-fully-legacy-recompute",
			project: null,
			// projectAttributionSource and agentAttributionSource intentionally omitted.
			requestBody: base64Body({
				system: "some text /home/u/projects/myrepo/main.ts more text",
			}),
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.project).toBe("myrepo");
		expect(summary.projectAttributionSource).toBe("path_project");
		expect(summary.agentAttributionSource).toBe("none");
	});

	test("branch A: authoritative project value is sanitized (control chars stripped) while the authoritative source is still honored", async () => {
		const rawProject = "ac\x1b[31m me\x07";
		const start = makeStart({
			requestId: "tristate-5-authoritative-value-sanitized",
			project: rawProject,
			projectAttributionSource: "header_project",
		});

		const summary = await runRequestAndGetSummary(start);

		// biome-ignore lint/suspicious/noControlCharactersInRegex: computing the expected sanitized value the same way sanitizeProjectName does
		const expected = rawProject.replace(/[\x00-\x1F\x7F]/g, "").trim();
		expect(summary.project).toBe(expected);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
		expect(summary.project ?? "").not.toMatch(/[\x00-\x1F\x7F]/);
		expect(summary.projectAttributionSource).toBe("header_project");
	});

	test('branch A: an authoritative project value that sanitizes to empty falls back to "none"', async () => {
		const start = makeStart({
			requestId: "tristate-6-authoritative-value-empties",
			project: " ",
			projectAttributionSource: "header_project",
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.project == null).toBe(true);
		expect(summary.projectAttributionSource).toBe("none");
	});
});
