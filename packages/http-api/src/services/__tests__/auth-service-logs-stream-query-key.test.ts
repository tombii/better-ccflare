/**
 * Tests for the /api/logs/stream query-string API key fallback added to
 * AuthService (issue #216, stage 1). The dashboard's live "Logs" tab opens a
 * native browser EventSource against `/api/logs/stream`; EventSource has no
 * API for setting custom request headers, so once API-key auth is enabled
 * the stream always 401'd and the live tab silently stopped working.
 *
 * AuthService now additionally accepts the key via `?api_key=` — but ONLY
 * for this one GET endpoint. Every other endpoint (including POST to the
 * same /api/logs/stream path, and every other /api/* or /v1/* path) must
 * continue to require the key via header/Bearer, unchanged.
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

describe("AuthService — /api/logs/stream query-string API key (#216)", () => {
	it("authenticates a GET /api/logs/stream request with a valid ?api_key= query param", async () => {
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

		expect(result.isAuthenticated).toBe(true);
	});

	it("rejects a GET /api/logs/stream request with an invalid ?api_key=", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request(
			"http://localhost/api/logs/stream?api_key=wrong-key",
			{ method: "GET" },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(false);
	});

	it("rejects a GET /api/logs/stream request with no key at all", async () => {
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

	it("still authenticates via header when both header and query key are present, preferring header", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request(
			"http://localhost/api/logs/stream?api_key=wrong-key",
			{ method: "GET", headers: { "x-api-key": RAW_KEY } },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"GET",
		);

		expect(result.isAuthenticated).toBe(true);
	});

	it("does NOT accept a query-string key on an unrelated /api/* path", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request(
			`http://localhost/api/accounts?api_key=${encodeURIComponent(RAW_KEY)}`,
			{ method: "GET" },
		);

		const result = await auth.authenticateRequest(req, "/api/accounts", "GET");

		expect(result.isAuthenticated).toBe(false);
	});

	it("does NOT accept a query-string key on /v1/* proxy paths", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request(
			`http://localhost/v1/messages?api_key=${encodeURIComponent(RAW_KEY)}`,
			{ method: "POST" },
		);

		const result = await auth.authenticateRequest(req, "/v1/messages", "POST");

		expect(result.isAuthenticated).toBe(false);
	});

	it("does NOT accept a query-string key on a non-GET request to /api/logs/stream", async () => {
		const dbOps = await makeDbOpsWithHashedKey();
		const auth = new AuthService(dbOps);
		const req = new Request(
			`http://localhost/api/logs/stream?api_key=${encodeURIComponent(RAW_KEY)}`,
			{ method: "POST" },
		);

		const result = await auth.authenticateRequest(
			req,
			"/api/logs/stream",
			"POST",
		);

		expect(result.isAuthenticated).toBe(false);
	});
});
