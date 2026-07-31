/**
 * Tests for createRequestsSummaryHandler's stream_terminal_state mapping.
 *
 * The column records the REAL outcome of an Anthropic-Messages-shaped SSE
 * stream (see packages/proxy/src/anthropic-terminal-recovery.ts). It was
 * written and preserved by the repository but no HTTP route read it back, so
 * an operator could not tell a client-cancelled or truncated stream from a
 * clean one — every such request still shows statusCode 200. These tests pin
 * the read path onto RequestResponse.streamTerminalState.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { createRequestsSummaryHandler } from "../requests";

const TEST_DB_PATH = "/tmp/test-requests-stream-terminal-state.db";

async function saveWithTerminalState(
	dbOps: DatabaseOperations,
	id: string,
	streamTerminalState:
		| "complete"
		| "recovered"
		| "error"
		| "truncated"
		| "client_cancelled"
		| null,
): Promise<void> {
	await dbOps.saveRequest(
		id,
		"POST",
		"/v1/messages",
		null, // accountUsed
		200, // statusCode
		true, // success
		null, // errorMessage
		100, // responseTime
		0, // failoverAttempts
		undefined, // usage
		undefined, // agentUsed
		undefined, // apiKeyId
		undefined, // apiKeyName
		undefined, // project
		undefined, // billingType
		undefined, // comboName
		undefined, // originalModel
		undefined, // appliedModel
		undefined, // projectAttributionSource
		undefined, // agentAttributionSource
		streamTerminalState,
	);
}

describe("createRequestsSummaryHandler — stream terminal state mapping", () => {
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

		await saveWithTerminalState(dbOps, "req-cancelled", "client_cancelled");
		await saveWithTerminalState(dbOps, "req-truncated", "truncated");
		await saveWithTerminalState(dbOps, "req-recovered", "recovered");
		await saveWithTerminalState(dbOps, "req-no-state", null);
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

	async function fetchRows(): Promise<RequestResponse[]> {
		const response = await handler(50);
		expect(response.status).toBe(200);
		return (await response.json()) as RequestResponse[];
	}

	it("maps stream_terminal_state onto the response", async () => {
		const body = await fetchRows();

		expect(
			body.find((r) => r.id === "req-cancelled")?.streamTerminalState,
		).toBe("client_cancelled");
		expect(
			body.find((r) => r.id === "req-truncated")?.streamTerminalState,
		).toBe("truncated");
		expect(
			body.find((r) => r.id === "req-recovered")?.streamTerminalState,
		).toBe("recovered");
	});

	it("omits the field when no terminal state was recorded", async () => {
		const body = await fetchRows();
		const row = body.find((r) => r.id === "req-no-state");

		expect(row).toBeDefined();
		expect(row?.streamTerminalState).toBeUndefined();
	});

	it('reports a state the build does not know as "unknown", not as absent', async () => {
		// The column is TEXT and nothing constrains it: a row written by a newer
		// producer build (or by hand) can hold a state outside the union. It must
		// not reach consumers that treat the union as exhaustive — but it must
		// also not collapse into the same `undefined` a non-streaming request
		// produces, or a NEW failure state would read as a clean 200.
		// Own row, so this mutation cannot influence the other assertions
		// regardless of test execution order.
		await saveWithTerminalState(dbOps, "req-unknown-state", "truncated");
		await dbOps
			.getAdapter()
			.run(`UPDATE requests SET stream_terminal_state = ? WHERE id = ?`, [
				"some_future_state",
				"req-unknown-state",
			]);

		const body = await fetchRows();
		const row = body.find((r) => r.id === "req-unknown-state");

		expect(row).toBeDefined();
		expect(row?.streamTerminalState).toBe("unknown");
		// …and still distinguishable from a request that recorded nothing.
		expect(
			body.find((r) => r.id === "req-no-state")?.streamTerminalState,
		).toBeUndefined();
	});

	it("narrows the sibling attribution columns the same way", async () => {
		// The neighbouring provenance columns are unconstrained TEXT too; leaving
		// them on a bare cast while hardening only this field would be an
		// asymmetry a reader cannot explain.
		await saveWithTerminalState(dbOps, "req-bad-attribution", "complete");
		await dbOps
			.getAdapter()
			.run(
				`UPDATE requests SET project_attribution_source = ?, agent_attribution_source = ? WHERE id = ?`,
				["not_a_source", "also_not_a_source", "req-bad-attribution"],
			);

		const body = await fetchRows();
		const row = body.find((r) => r.id === "req-bad-attribution");

		expect(row).toBeDefined();
		expect(row?.projectAttributionSource).toBeUndefined();
		expect(row?.agentAttributionSource).toBeUndefined();
	});

	it("keeps a cancelled stream distinguishable from a clean 200", async () => {
		// The whole point of the column: statusCode alone cannot tell these
		// apart, which is exactly why the stalls of 2026-07-30 read as healthy.
		const body = await fetchRows();
		const cancelled = body.find((r) => r.id === "req-cancelled");
		const clean = body.find((r) => r.id === "req-no-state");

		expect(cancelled?.statusCode).toBe(clean?.statusCode);
		expect(cancelled?.streamTerminalState).not.toBe(clean?.streamTerminalState);
	});
});
