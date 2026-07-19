import { afterEach, describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// These tests drive the REAL xAI/Codex providers (via row.provider) and mock
// global.fetch to return an OAuth error, so the whole provider→scheduler detection
// chain is exercised without mock.module (which leaks across proxy test files).

interface ProactiveRow {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	custom_endpoint: string | null;
}

function makeDb(queryRows: ProactiveRow[]) {
	const runCalls: Array<[string, unknown[]]> = [];
	const queries: string[] = [];
	const db = {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async (sql: string) => {
			queries.push(sql);
			return queryRows;
		}),
	};
	return { db, runCalls, queries };
}

function makeScheduler(db: unknown) {
	return new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
		} as never,
	) as unknown as {
		checkAndRefreshOpenAICompatibleOAuthTokens(): Promise<void>;
		checkAndRefreshCodexTokens(): Promise<void>;
	};
}

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});

describe("AutoRefreshScheduler proactive refresh — requires_reauth guard", () => {
	it("excludes flagged accounts from the OpenAI-compatible eligibility query", async () => {
		const { db, queries } = makeDb([]);
		const scheduler = makeScheduler(db);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		const sql = queries.find((q) => q.includes("'qwen', 'xai'"));
		expect(sql).toBeDefined();
		expect(sql).toContain("COALESCE(requires_reauth, 0) = 0");
	});

	it("excludes flagged accounts from the Codex eligibility query", async () => {
		const { db, queries } = makeDb([]);
		const scheduler = makeScheduler(db);

		await scheduler.checkAndRefreshCodexTokens();

		const sql = queries.find((q) => q.includes("provider = 'codex'"));
		expect(sql).toBeDefined();
		expect(sql).toContain("COALESCE(requires_reauth, 0) = 0");
	});
});

describe("AutoRefreshScheduler proactive refresh — definitive auth failure", () => {
	it("flags an xAI account whose proactive refresh returns invalid_grant and emits the event", async () => {
		const { db, runCalls } = makeDb([
			{
				id: "xai-dead",
				name: "xai-dead",
				provider: "xai",
				refresh_token: "rt",
				access_token: "at",
				expires_at: 1,
				custom_endpoint: null,
			},
		]);
		global.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "Refresh token is invalid or has been revoked.",
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;
		const emitted: AuthFailureEvt[] = [];
		authFailureEvents.once("event", (event) => emitted.push(event));

		const scheduler = makeScheduler(db);
		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		const flagWrite = runCalls.find(([sql]) => sql.includes("requires_reauth"));
		expect(flagWrite).toBeDefined();
		expect(flagWrite?.[1]).toEqual(["xai-dead"]);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			accountId: "xai-dead",
			provider: "xai",
			reason: "invalid_grant",
		});
	});

	it("flags a Codex account whose proactive refresh returns refresh_token_reused", async () => {
		const { db, runCalls } = makeDb([
			{
				id: "codex-dead",
				name: "codex-dead",
				provider: "codex",
				refresh_token: "rt",
				access_token: "at",
				expires_at: 1,
				custom_endpoint: null,
			},
		]);
		global.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "refresh_token_reused" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const emitted: AuthFailureEvt[] = [];
		authFailureEvents.once("event", (event) => emitted.push(event));

		const scheduler = makeScheduler(db);
		await scheduler.checkAndRefreshCodexTokens();

		const flagWrite = runCalls.find(([sql]) => sql.includes("requires_reauth"));
		expect(flagWrite).toBeDefined();
		expect(flagWrite?.[1]).toEqual(["codex-dead"]);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.reason).toBe("refresh_token_reused");
	});

	it("does NOT flag a proactive refresh that fails with a transient network error", async () => {
		const { db, runCalls } = makeDb([
			{
				id: "codex-net",
				name: "codex-net",
				provider: "codex",
				refresh_token: "rt",
				access_token: "at",
				expires_at: 1,
				custom_endpoint: null,
			},
		]);
		// A 5xx with no OAuth error code — a transient upstream failure.
		global.fetch = mock(
			async () => new Response("Service Unavailable", { status: 503 }),
		) as unknown as typeof fetch;
		let emittedCount = 0;
		const listener = () => {
			emittedCount++;
		};
		authFailureEvents.on("event", listener);

		try {
			const scheduler = makeScheduler(db);
			await scheduler.checkAndRefreshCodexTokens();
		} finally {
			authFailureEvents.off("event", listener);
		}

		const flagWrite = runCalls.find(([sql]) => sql.includes("requires_reauth"));
		expect(flagWrite).toBeUndefined();
		expect(emittedCount).toBe(0);
	});
});
