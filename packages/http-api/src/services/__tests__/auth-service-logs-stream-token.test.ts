/**
 * Tests for the /api/logs/stream short-lived token mechanism (PR #379 review
 * fix). The dashboard's live "Logs" tab opens a native browser EventSource
 * against `/api/logs/stream`; EventSource has no API for setting custom
 * request headers, so the previous fix (issue #216) accepted the durable API
 * key via `?api_key=`. That put a long-lived credential in the URL, risking
 * exposure via browser history, Referer headers, or reverse-proxy/access
 * logs.
 *
 * AuthService now instead mints a short-lived, single-use token
 * (mintLogsStreamToken) via a normally-authenticated endpoint
 * (POST /api/logs/stream/token), and GET /api/logs/stream accepts that token
 * via `?stream_token=` instead of the raw key. Every other endpoint
 * (including POST to the same /api/logs/stream path, and every other
 * /api/* or /v1/* path) must continue to require the key via header/Bearer,
 * unchanged.
 */
import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { NodeCryptoUtils } from "@better-ccflare/types";
import { AuthService } from "../auth-service";

const RAW_KEY = "sk-test-logs-stream-key";

async function makeDbOpsWithHashedKey(): Promise<DatabaseOperations> {
	const crypto = new NodeCryptoUtils();
	const hashedKey = await crypto.hashApiKey(RAW_KEY);
	const keyRecord = {
		id: "key-1",
		name: "test-key",
		hashedKey,
		prefixLast8: RAW_KEY.slice(-8),
		role: "admin" as const,
	};
	return {
		countActiveApiKeys: async () => 1,
		getActiveApiKeys: async () => [keyRecord],
		updateApiKeyUsage: () => {},
	} as unknown as DatabaseOperations;
}

describe("AuthService — /api/logs/stream token (#379)", () => {
	it("authenticates a GET /api/logs/stream request with a valid ?stream_token= once", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const token = auth.mintLogsStreamToken("key-1", "admin");

		const req = new Request(
			`http://localhost/api/logs/stream?stream_token=${encodeURIComponent(token)}`,
			{ method: "GET" },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(true);
		expect(result.apiKeyId).toBe("key-1");
		expect(result.role).toBe("admin");
	});

	it("rejects reuse of an already-consumed token (single-use)", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const token = auth.mintLogsStreamToken("key-1", "admin");

		const makeReq = () =>
			new Request(
				`http://localhost/api/logs/stream?stream_token=${encodeURIComponent(token)}`,
				{ method: "GET" },
			);

		const first = await auth.authenticateRequest(
			makeReq(),
			"/api/logs/stream",
			"GET",
		);
		expect(first.isAuthenticated).toBe(true);

		const second = await auth.authenticateRequest(
			makeReq(),
			"/api/logs/stream",
			"GET",
		);
		expect(second.isAuthenticated).toBe(false);
	});

	it("rejects an unknown/invalid token", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);

		const req = new Request(
			"http://localhost/api/logs/stream?stream_token=not-a-real-token",
			{ method: "GET" },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(false);
	});

	it("rejects an expired token", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const token = auth.mintLogsStreamToken("key-1", "admin");

		// Force expiry by reaching into the private token map — there is no
		// public API to fast-forward time, and the TTL is short (60s) so a
		// real sleep in a unit test is undesirable.
		// biome-ignore lint/suspicious/noExplicitAny: reaching into private state for test-only expiry simulation
		const tokens = (auth as any).streamTokens as Map<
			string,
			{ expiresAt: number }
		>;
		const record = tokens.get(token);
		expect(record).toBeDefined();
		if (record) {
			record.expiresAt = Date.now() - 1000;
		}

		const req = new Request(
			`http://localhost/api/logs/stream?stream_token=${encodeURIComponent(token)}`,
			{ method: "GET" },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(false);
	});

	it("rejects a GET /api/logs/stream request with no token and no header", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request("http://localhost/api/logs/stream", {
			method: "GET",
		});

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(false);
	});

	it("still authenticates via header when a header key is present (no token needed)", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request("http://localhost/api/logs/stream", {
			method: "GET",
			headers: { "x-api-key": RAW_KEY },
		});

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(true);
	});

	it("does NOT accept the raw API key via ?api_key= anymore", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request(
			`http://localhost/api/logs/stream?api_key=${encodeURIComponent(RAW_KEY)}`,
			{ method: "GET" },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(false);
	});

	it("does NOT accept a stream_token on an unrelated /api/* path", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const token = auth.mintLogsStreamToken("key-1", "admin");
		const req = new Request(
			`http://localhost/api/accounts?stream_token=${encodeURIComponent(token)}`,
			{ method: "GET" },
		);

		const result = await auth.authenticateRequest(req, "/api/accounts", "GET");

		expect(result.isAuthenticated).toBe(false);
	});

	it("does NOT accept a stream_token on /v1/* proxy paths", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const token = auth.mintLogsStreamToken("key-1", "admin");
		const req = new Request(
			`http://localhost/v1/messages?stream_token=${encodeURIComponent(token)}`,
			{ method: "POST" },
		);

		const result = await auth.authenticateRequest(req, "/v1/messages", "POST");

		expect(result.isAuthenticated).toBe(false);
	});

	it("does NOT accept a stream_token on a non-GET request to /api/logs/stream", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const token = auth.mintLogsStreamToken("key-1", "admin");
		const req = new Request(
			`http://localhost/api/logs/stream?stream_token=${encodeURIComponent(token)}`,
			{ method: "POST" },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"POST",
		);

		expect(result.isAuthenticated).toBe(false);
	});

	it("mintLogsStreamToken requires the router to have already authenticated the caller (not exempt by itself)", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);

		// POST /api/logs/stream/token is a normal /api/* path with no static
		// or header-based exemption, so it must fail without a valid API key
		// just like any other /api/* endpoint.
		const req = new Request("http://localhost/api/logs/stream/token", {
			method: "POST",
		});

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream/token",
			"POST",
		);

		expect(result.isAuthenticated).toBe(false);
	});
});
