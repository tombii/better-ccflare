/**
 * Tests for the read-only `web_tool_calls` HTTP surface.
 *
 * The store is an in-memory fake that records how it was called, so the
 * assertions cover both the response envelope and the clamping/filtering the
 * handler performs before it reaches the database.
 */
import { describe, expect, it } from "bun:test";
import type {
	WebToolCall,
	WebToolCallStatus,
	WebToolCallSummary,
} from "@better-ccflare/types";
import {
	createWebToolCallHandlers,
	DEFAULT_LIST_LIMIT,
	DEFAULT_SUMMARY_HOURS,
	type WebToolCallStore,
} from "../web-tool-calls";

const NOW = 1_700_000_000_000;

function call(overrides: Partial<WebToolCall> = {}): WebToolCall {
	return {
		id: "call-1",
		timestamp: NOW - 1_000,
		tool: "web_search",
		providerId: "row-1",
		providerKind: "tavily",
		accountId: null,
		project: "/repo/a",
		queryText: "bun test mocks",
		queryChars: 15,
		resultCount: 3,
		latencyMs: 120,
		status: "ok",
		errorCode: null,
		estimatedCostUsd: null,
		...overrides,
	};
}

function summary(
	overrides: Partial<WebToolCallSummary> = {},
): WebToolCallSummary {
	return {
		providerKind: "tavily",
		status: "ok",
		callCount: 2,
		totalLatencyMs: 200,
		avgLatencyMs: 100,
		totalResults: 5,
		...overrides,
	};
}

function makeStore(options: { rows?: WebToolCall[]; fail?: boolean } = {}) {
	const listCalls: Array<{
		limit: number;
		filters?: {
			status?: WebToolCallStatus;
			providerKind?: string;
			since?: number;
		};
	}> = [];
	const summarySince: number[] = [];
	const store: WebToolCallStore = {
		async listWebToolCalls(limit, filters) {
			listCalls.push({ limit, filters });
			if (options.fail) throw new Error("db down");
			const rows = (options.rows ?? [call()]).filter(
				(row) =>
					(!filters?.status || row.status === filters.status) &&
					(!filters?.providerKind ||
						row.providerKind === filters.providerKind) &&
					(filters?.since === undefined || row.timestamp >= filters.since),
			);
			return rows.slice(0, limit);
		},
		async webToolCallSummary(since) {
			summarySince.push(since);
			if (options.fail) throw new Error("db down");
			return [summary()];
		},
	};
	return { store, listCalls, summarySince };
}

function params(query = ""): URLSearchParams {
	return new URLSearchParams(query);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/web-tool-calls", () => {
	it("wraps rows in the success envelope with a count", async () => {
		const rows = [call(), call({ id: "call-2", status: "fallthrough" })];
		const { store } = makeStore({ rows });
		const handlers = createWebToolCallHandlers(store, () => NOW);

		const res = await handlers.list(params());
		expect(res.status).toBe(200);
		const body = await readJson(res);
		expect(body.success).toBe(true);
		expect(body.count).toBe(2);
		expect(body.data).toHaveLength(2);
		const data = body.data as WebToolCall[];
		expect(data[0]?.id).toBe("call-1");
	});

	it("defaults the limit to 50", async () => {
		const { store, listCalls } = makeStore();
		await createWebToolCallHandlers(store).list(params());
		expect(listCalls[0]?.limit).toBe(DEFAULT_LIST_LIMIT);
	});

	it("clamps the limit into 1..200", async () => {
		const { store, listCalls } = makeStore();
		const handlers = createWebToolCallHandlers(store);

		await handlers.list(params("limit=5"));
		await handlers.list(params("limit=5000"));
		await handlers.list(params("limit=0"));
		await handlers.list(params("limit=abc"));

		expect(listCalls.map((c) => c.limit)).toEqual([5, 200, 50, 50]);
	});

	it("passes status, providerKind and since filters through", async () => {
		const { store, listCalls } = makeStore();
		const handlers = createWebToolCallHandlers(store);

		await handlers.list(
			params("status=fallthrough&providerKind=tavily&since=1700000000000"),
		);
		expect(listCalls[0]?.filters).toEqual({
			status: "fallthrough",
			providerKind: "tavily",
			since: NOW,
		});
	});

	it("treats an epoch-seconds since as seconds", async () => {
		const { store, listCalls } = makeStore();
		await createWebToolCallHandlers(store).list(params("since=1700000000"));
		expect(listCalls[0]?.filters?.since).toBe(NOW);
	});

	it("treats an ISO date since as that instant", async () => {
		const { store, listCalls } = makeStore();
		await createWebToolCallHandlers(store).list(
			params(`since=${encodeURIComponent("2023-11-14T22:13:20.000Z")}`),
		);
		expect(listCalls[0]?.filters?.since).toBe(NOW);
	});

	it("rejects an unknown status with 400", async () => {
		const { store, listCalls } = makeStore();
		const res = await createWebToolCallHandlers(store).list(
			params("status=banana"),
		);
		expect(res.status).toBe(400);
		expect((await readJson(res)).error).toContain("banana");
		expect(listCalls).toHaveLength(0);
	});

	it("rejects a malformed since with 400", async () => {
		const { store, listCalls } = makeStore();
		const res = await createWebToolCallHandlers(store).list(
			params("since=not-a-date"),
		);
		expect(res.status).toBe(400);
		expect(listCalls).toHaveLength(0);
	});

	it("ignores empty filters (the dashboard's 'all' option)", async () => {
		const { store, listCalls } = makeStore();
		await createWebToolCallHandlers(store).list(
			params("status=&providerKind=&since="),
		);
		expect(listCalls[0]?.filters).toEqual({
			status: undefined,
			providerKind: undefined,
			since: undefined,
		});
	});

	it("returns 500 when the store fails", async () => {
		const { store } = makeStore({ fail: true });
		const res = await createWebToolCallHandlers(store).list(params());
		expect(res.status).toBe(500);
		const body = await readJson(res);
		expect(body.success).toBeUndefined();
		expect(body.error).toBeDefined();
	});
});

describe("GET /api/web-tool-calls/summary", () => {
	it("returns summary buckets for the default 24h window", async () => {
		const { store, summarySince } = makeStore();
		const res = await createWebToolCallHandlers(store, () => NOW).summary(
			params(),
		);
		expect(res.status).toBe(200);
		const body = await readJson(res);
		expect(body.success).toBe(true);
		expect(body.data).toEqual([summary()]);
		expect(summarySince[0]).toBe(NOW - DEFAULT_SUMMARY_HOURS * 3_600_000);
	});

	it("clamps hours into 1..8760", async () => {
		const { store, summarySince } = makeStore();
		const handlers = createWebToolCallHandlers(store, () => NOW);

		await handlers.summary(params("hours=6"));
		await handlers.summary(params("hours=99999"));
		await handlers.summary(params("hours=0"));

		expect(summarySince).toEqual([
			NOW - 6 * 3_600_000,
			NOW - 8760 * 3_600_000,
			NOW - 24 * 3_600_000,
		]);
	});

	it("returns 500 when the store fails", async () => {
		const { store } = makeStore({ fail: true });
		const res = await createWebToolCallHandlers(store).summary(params());
		expect(res.status).toBe(500);
	});
});
