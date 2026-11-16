import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	createCodeBuddyDeviceFlowInitHandler,
	createCodeBuddyDeviceFlowStatusHandler,
	createCodeBuddyReauthHandler,
	resetCodeBuddySessionsForTests,
} from "../oauth";

/**
 * Serve the two CodeBuddy auth endpoints. Mocking `fetch` (rather than
 * `mock.module`) keeps this file from replacing @better-ccflare/providers
 * globally — Bun's module mocks leak across test files in the same process.
 */
function installAuthFetch(options: { failToken?: boolean } = {}): void {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;

		if (url.includes("/v2/plugin/auth/state")) {
			return Response.json({
				code: 0,
				data: {
					state: "test-state",
					authUrl: "https://www.codebuddy.ai/login?state=test-state",
				},
			});
		}

		if (url.includes("/v2/plugin/auth/token")) {
			if (options.failToken) {
				return Response.json({ code: 40001, msg: "login expired" });
			}
			return Response.json({
				code: 0,
				data: {
					accessToken: "access-token",
					refreshToken: "refresh-token",
					expiresIn: 1800,
				},
			});
		}

		throw new Error(`Unexpected fetch: ${url}`);
	}) as typeof fetch;
}

async function waitForStatus(
	statusHandler: (sessionId: string) => Response,
	sessionId: string,
	timeoutMs = 5000,
): Promise<{ status: string; error?: string }> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = statusHandler(sessionId);
		const data = (await res.json()) as { status: string; error?: string };
		if (data.status === "complete" || data.status === "error") return data;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for session ${sessionId}`);
}

describe("CodeBuddy auth handlers", () => {
	let dbOps: DatabaseOperations;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		originalFetch = globalThis.fetch;
		installAuthFetch();
	});

	afterEach(async () => {
		resetCodeBuddySessionsForTests();
		mock.restore();
		globalThis.fetch = originalFetch;
		await dbOps.close();
	});

	async function seedCodeBuddyAccount(): Promise<void> {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (
				id, name, provider, access_token, refresh_token, expires_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"codebuddy-existing-id",
				"codebuddy-one",
				"codebuddy",
				"old-access-token",
				"old-refresh-token",
				Date.now() - 1,
				Date.now(),
			],
		);
	}

	it("creates an account after the login poll completes", async () => {
		const init = createCodeBuddyDeviceFlowInitHandler(dbOps);
		const status = createCodeBuddyDeviceFlowStatusHandler();

		const response = await init(
			new Request("http://localhost/api/oauth/codebuddy/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "codebuddy-one", priority: 5 }),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			sessionId: string;
			authUrl: string;
		};
		expect(body.success).toBe(true);
		expect(body.authUrl).toContain("codebuddy.ai");
		expect(typeof body.sessionId).toBe("string");

		const final = await waitForStatus(status, body.sessionId);
		expect(final.status).toBe("complete");

		const row = await dbOps.getAdapter().get<{
			provider: string;
			access_token: string;
			refresh_token: string;
			expires_at: number;
			priority: number;
		}>(
			"SELECT provider, access_token, refresh_token, expires_at, priority FROM accounts WHERE name = ?",
			["codebuddy-one"],
		);

		expect(row?.provider).toBe("codebuddy");
		expect(row?.access_token).toBe("access-token");
		expect(row?.refresh_token).toBe("refresh-token");
		expect(row?.priority).toBe(5);
		expect(row?.expires_at).toBeGreaterThan(Date.now());
	});

	it("reports a duplicate account name as an error", async () => {
		await seedCodeBuddyAccount();
		const init = createCodeBuddyDeviceFlowInitHandler(dbOps);
		const status = createCodeBuddyDeviceFlowStatusHandler();

		const response = await init(
			new Request("http://localhost/api/oauth/codebuddy/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "codebuddy-one" }),
			}),
		);

		const body = (await response.json()) as { sessionId: string };
		const final = await waitForStatus(status, body.sessionId);

		expect(final.status).toBe("error");
		expect(final.error).toContain("already taken");
	});

	it("rejects re-authentication for a different provider", async () => {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, request_count, total_requests, priority
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
			[
				"other-provider-id",
				"not-codebuddy",
				"codex",
				null,
				"r",
				"a",
				Date.now() + 60_000,
				Date.now(),
			],
		);

		const reauth = createCodeBuddyReauthHandler(dbOps);
		const response = await reauth(
			new Request("http://localhost/api/oauth/codebuddy/reauth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accountId: "other-provider-id" }),
			}),
		);

		expect(response.status).toBe(400);
	});

	it("refreshes tokens for an existing CodeBuddy account", async () => {
		await seedCodeBuddyAccount();
		const reauth = createCodeBuddyReauthHandler(dbOps);
		const status = createCodeBuddyDeviceFlowStatusHandler();

		const row = await dbOps
			.getAdapter()
			.get<{ id: string }>("SELECT id FROM accounts WHERE name = ?", [
				"codebuddy-one",
			]);
		expect(row?.id).toBeDefined();

		const response = await reauth(
			new Request("http://localhost/api/oauth/codebuddy/reauth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accountId: row?.id }),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { sessionId: string };
		const final = await waitForStatus(status, body.sessionId);
		expect(final.status).toBe("complete");
	});

	it("surfaces a poll failure through the status endpoint", async () => {
		installAuthFetch({ failToken: true });
		const init = createCodeBuddyDeviceFlowInitHandler(dbOps);
		const status = createCodeBuddyDeviceFlowStatusHandler();

		const response = await init(
			new Request("http://localhost/api/oauth/codebuddy/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "codebuddy-failing" }),
			}),
		);
		const body = (await response.json()) as { sessionId: string };
		const final = await waitForStatus(status, body.sessionId);

		expect(final.status).toBe("error");
		expect(final.error).toContain("login expired");
	});

	it("returns 404 for an unknown session", async () => {
		const status = createCodeBuddyDeviceFlowStatusHandler();
		const response = status("does-not-exist");
		expect(response.status).toBe(404);
	});

	it("clears completed sessions and cancels their expiry timers on reset", async () => {
		const schedule = spyOn(globalThis, "setTimeout");
		const cancel = spyOn(globalThis, "clearTimeout");
		const init = createCodeBuddyDeviceFlowInitHandler(dbOps);
		const status = createCodeBuddyDeviceFlowStatusHandler();
		const response = await init(
			new Request("http://localhost/api/oauth/codebuddy/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "codebuddy-reset" }),
			}),
		);
		const { sessionId } = (await response.json()) as { sessionId: string };
		expect((await waitForStatus(status, sessionId)).status).toBe("complete");
		const expirationCall = schedule.mock.calls.findIndex(
			([, delay]) => delay === 10 * 60 * 1000,
		);
		expect(expirationCall).toBeGreaterThanOrEqual(0);
		const expirationTimer = schedule.mock.results[expirationCall]?.value;
		expect(expirationTimer).toBeDefined();

		resetCodeBuddySessionsForTests();

		expect(status(sessionId).status).toBe(404);
		expect(cancel).toHaveBeenCalledWith(expirationTimer);
	});
});
