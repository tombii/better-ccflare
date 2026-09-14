/**
 * PATCH /api/api-keys/:idOrName/restrictions, and the restrictions half of
 * POST /api/api-keys.
 *
 * The invariant every case here is really about: `null` means unrestricted and
 * `[]` means deny-all, and no layer between the request body and the stored
 * column is allowed to blur the two.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { NodeCryptoUtils } from "@better-ccflare/types";
import { APIRouter } from "../../router";
import type { APIContext } from "../../types";
import {
	createApiKeysGenerateHandler,
	createApiKeysListHandler,
	createApiKeyUpdateRestrictionsHandler,
} from "../api-keys";

// One database file per describe block. Sharing a single path across blocks
// lets one block's cleanup race the next block's open, which surfaces as an
// unhandled error between tests rather than a failure in either.
const TEST_DB_ROOT = process.env.TMPDIR || "/tmp";

function cleanupDbFiles(path: string) {
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			const p = `${path}${suffix}`;
			if (existsSync(p)) unlinkSync(p);
		} catch {
			// best-effort cleanup
		}
	}
}

interface StoredRestrictions {
	allowed_accounts: string | null;
	allowed_models: string | null;
	allowed_providers: string | null;
}

describe("PATCH /api/api-keys/:idOrName/restrictions", () => {
	const TEST_DB_PATH = `${TEST_DB_ROOT}/test-api-key-restrictions-patch.db`;
	let dbOps: DatabaseOperations;
	let handler: (req: Request, keyIdOrName: string) => Promise<Response>;
	let keyId: string;

	beforeEach(async () => {
		cleanupDbFiles(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createApiKeyUpdateRestrictionsHandler(dbOps);

		keyId = crypto.randomUUID();
		await dbOps.createApiKey({
			id: keyId,
			name: "scoped-key",
			hashedKey: `hash-${keyId}`,
			prefixLast8: "abcdefgh",
			createdAt: Date.now(),
			isActive: true,
			role: "admin",
		});
	});

	afterEach(() => {
		DatabaseFactory.reset();
		cleanupDbFiles(TEST_DB_PATH);
	});

	function makeRequest(body: unknown): Request {
		return new Request(`http://localhost/api/api-keys/${keyId}/restrictions`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function stored(): Promise<StoredRestrictions | null> {
		const row = await dbOps
			.getAdapter()
			.get<StoredRestrictions>(
				"SELECT allowed_accounts, allowed_models, allowed_providers FROM api_keys WHERE id = ?",
				[keyId],
			);
		return row ?? null;
	}

	it("starts unrestricted: all three columns NULL", async () => {
		expect(await stored()).toEqual({
			allowed_accounts: null,
			allowed_models: null,
			allowed_providers: null,
		});
	});

	it("persists the three lists as JSON arrays", async () => {
		const res = await handler(
			makeRequest({
				allowedAccounts: ["acc-1", "acc-2"],
				allowedModels: ["opus"],
				allowedProviders: ["zai"],
			}),
			keyId,
		);

		expect(res.status).toBe(200);
		expect(await stored()).toEqual({
			allowed_accounts: '["acc-1","acc-2"]',
			allowed_models: '["opus"]',
			allowed_providers: '["zai"]',
		});
	});

	it("round-trips an empty array as deny-all, never as NULL", async () => {
		const res = await handler(
			makeRequest({
				allowedAccounts: [],
				allowedModels: null,
				allowedProviders: null,
			}),
			keyId,
		);

		expect(res.status).toBe(200);
		const row = await stored();
		// The distinction the whole feature rests on.
		expect(row?.allowed_accounts).toBe("[]");
		expect(row?.allowed_models).toBeNull();
	});

	it("clears a restriction back to NULL when sent null", async () => {
		await handler(
			makeRequest({
				allowedAccounts: ["acc-1"],
				allowedModels: ["opus"],
				allowedProviders: null,
			}),
			keyId,
		);
		const res = await handler(
			makeRequest({
				allowedAccounts: null,
				allowedModels: null,
				allowedProviders: null,
			}),
			keyId,
		);

		expect(res.status).toBe(200);
		expect(await stored()).toEqual({
			allowed_accounts: null,
			allowed_models: null,
			allowed_providers: null,
		});
	});

	it("surfaces the stored lists back through GET /api/api-keys", async () => {
		await handler(
			makeRequest({
				allowedAccounts: ["acc-1"],
				allowedModels: [],
				allowedProviders: null,
			}),
			keyId,
		);

		const listRes = await createApiKeysListHandler(dbOps)();
		const body = (await listRes.json()) as {
			data: Array<{
				id: string;
				allowedAccounts: string[] | null;
				allowedModels: string[] | null;
				allowedProviders: string[] | null;
			}>;
		};
		const row = body.data.find((entry) => entry.id === keyId);
		expect(row?.allowedAccounts).toEqual(["acc-1"]);
		expect(row?.allowedModels).toEqual([]);
		expect(row?.allowedProviders).toBeNull();
	});

	it("rejects an unknown provider name", async () => {
		const res = await handler(
			makeRequest({
				allowedAccounts: null,
				allowedModels: null,
				allowedProviders: ["not-a-real-provider"],
			}),
			keyId,
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("allowedProviders");
		// Nothing was written.
		expect((await stored())?.allowed_providers).toBeNull();
	});

	it("accepts every name in the authoritative provider list", async () => {
		const res = await handler(
			makeRequest({
				allowedAccounts: null,
				allowedModels: null,
				allowedProviders: ["anthropic", "codex", "ollama-cloud", "vertex-ai"],
			}),
			keyId,
		);

		expect(res.status).toBe(200);
	});

	it("rejects a non-array value", async () => {
		const res = await handler(
			makeRequest({
				allowedAccounts: "acc-1",
				allowedModels: null,
				allowedProviders: null,
			}),
			keyId,
		);

		expect(res.status).toBe(400);
	});

	it("rejects non-string and empty entries", async () => {
		for (const bad of [[1], [""], ["  "], [null]]) {
			const res = await handler(
				makeRequest({
					allowedAccounts: bad,
					allowedModels: null,
					allowedProviders: null,
				}),
				keyId,
			);
			expect(res.status).toBe(400);
		}
	});

	it("requires all three fields, so a partial body cannot silently clear one", async () => {
		await handler(
			makeRequest({
				allowedAccounts: ["acc-1"],
				allowedModels: ["opus"],
				allowedProviders: null,
			}),
			keyId,
		);

		const res = await handler(
			makeRequest({ allowedAccounts: ["acc-2"] }),
			keyId,
		);

		expect(res.status).toBe(400);
		// allowedModels survived — the partial body changed nothing at all.
		expect((await stored())?.allowed_models).toBe('["opus"]');
	});

	it("de-duplicates repeated entries", async () => {
		await handler(
			makeRequest({
				allowedAccounts: ["acc-1", "acc-1", " acc-1 "],
				allowedModels: null,
				allowedProviders: null,
			}),
			keyId,
		);

		expect((await stored())?.allowed_accounts).toBe('["acc-1"]');
	});

	it("accepts a key name as well as an id", async () => {
		const res = await handler(
			new Request("http://localhost/api/api-keys/scoped-key/restrictions", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					allowedAccounts: ["acc-7"],
					allowedModels: null,
					allowedProviders: null,
				}),
			}),
			"scoped-key",
		);

		expect(res.status).toBe(200);
		expect((await stored())?.allowed_accounts).toBe('["acc-7"]');
	});

	it("404s for a key that does not exist", async () => {
		const res = await handler(
			makeRequest({
				allowedAccounts: null,
				allowedModels: null,
				allowedProviders: null,
			}),
			"no-such-key",
		);

		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe("POST /api/api-keys — restrictions at creation", () => {
	const TEST_DB_PATH = `${TEST_DB_ROOT}/test-api-key-restrictions-create.db`;
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		cleanupDbFiles(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		DatabaseFactory.reset();
		cleanupDbFiles(TEST_DB_PATH);
	});

	function makeCreateRequest(body: unknown): Request {
		return new Request("http://localhost/api/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("creates an unrestricted key when no restrictions are sent", async () => {
		const res = await createApiKeysGenerateHandler(dbOps)(
			makeCreateRequest({ name: "plain", role: "admin" }),
		);
		expect(res.status).toBe(201);

		const row = await dbOps
			.getAdapter()
			.get<StoredRestrictions>(
				"SELECT allowed_accounts, allowed_models, allowed_providers FROM api_keys WHERE name = ?",
				["plain"],
			);
		expect(row).toEqual({
			allowed_accounts: null,
			allowed_models: null,
			allowed_providers: null,
		});
	});

	it("stores restrictions supplied at creation", async () => {
		const res = await createApiKeysGenerateHandler(dbOps)(
			makeCreateRequest({
				name: "scoped",
				role: "admin",
				allowedModels: ["haiku"],
				allowedProviders: ["ollama"],
			}),
		);
		expect(res.status).toBe(201);

		const row = await dbOps
			.getAdapter()
			.get<StoredRestrictions>(
				"SELECT allowed_accounts, allowed_models, allowed_providers FROM api_keys WHERE name = ?",
				["scoped"],
			);
		expect(row?.allowed_models).toBe('["haiku"]');
		expect(row?.allowed_providers).toBe('["ollama"]');
		// Omitted at creation means unrestricted, not deny-all.
		expect(row?.allowed_accounts).toBeNull();
	});

	it("rejects an unknown provider at creation without creating the key", async () => {
		const res = await createApiKeysGenerateHandler(dbOps)(
			makeCreateRequest({
				name: "bad",
				role: "admin",
				allowedProviders: ["nope"],
			}),
		);
		expect(res.status).toBe(400);
		expect(await dbOps.getApiKeyByName("bad")).toBeNull();
	});
});

describe("PATCH /api/api-keys/:idOrName/restrictions — admin gate", () => {
	const TEST_DB_PATH = `${TEST_DB_ROOT}/test-api-key-restrictions-gate.db`;
	let dbOps: DatabaseOperations;
	let router: APIRouter;
	let adminKey: string;
	let apiOnlyKey: string;
	let targetId: string;

	async function addKey(
		name: string,
		role: "admin" | "api-only",
	): Promise<string> {
		const crypto_ = new NodeCryptoUtils();
		const plain = await crypto_.generateApiKey();
		await dbOps.createApiKey({
			id: globalThis.crypto.randomUUID(),
			name,
			hashedKey: await crypto_.hashApiKey(plain),
			prefixLast8: plain.slice(-8),
			createdAt: Date.now(),
			isActive: true,
			role,
		});
		return plain;
	}

	beforeEach(async () => {
		cleanupDbFiles(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		adminKey = await addKey("admin-key", "admin");
		apiOnlyKey = await addKey("api-only-key", "api-only");

		targetId = globalThis.crypto.randomUUID();
		await dbOps.createApiKey({
			id: targetId,
			name: "target-key",
			hashedKey: `hash-${targetId}`,
			prefixLast8: "12345678",
			createdAt: Date.now(),
			isActive: true,
			role: "api-only",
		});

		router = new APIRouter({
			db: dbOps.getAdapter(),
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
			} as unknown as Config,
			dbOps,
			alertService: {
				listAlerts: async () => [],
				getUnacknowledgedCount: async () => 0,
				acknowledgeAlert: async () => true,
				acknowledgeAll: async () => {},
			},
		} as unknown as APIContext);
	});

	afterEach(async () => {
		// AuthService#validateApiKey fires `updateApiKeyUsage` without awaiting
		// it. Closing the database out from under that in-flight write turns it
		// into an unhandled rejection between test files, so let it settle
		// first. Harness-only: nothing in the product waits on that write.
		await new Promise((resolve) => setTimeout(resolve, 50));
		DatabaseFactory.reset();
		cleanupDbFiles(TEST_DB_PATH);
	});

	function patch(apiKey: string): { url: URL; req: Request } {
		const url = new URL(
			`http://localhost/api/api-keys/${targetId}/restrictions`,
		);
		const req = new Request(url, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "x-api-key": apiKey },
			body: JSON.stringify({
				allowedAccounts: ["acc-1"],
				allowedModels: null,
				allowedProviders: null,
			}),
		});
		return { url, req };
	}

	it("lets an admin key set restrictions", async () => {
		const { url, req } = patch(adminKey);
		const res = await router.handleRequest(url, req);
		expect(res?.status).toBe(200);

		const row = await dbOps
			.getAdapter()
			.get<StoredRestrictions>(
				"SELECT allowed_accounts, allowed_models, allowed_providers FROM api_keys WHERE id = ?",
				[targetId],
			);
		expect(row?.allowed_accounts).toBe('["acc-1"]');
	});

	it("refuses an api-only key, and writes nothing", async () => {
		const { url, req } = patch(apiOnlyKey);
		const res = await router.handleRequest(url, req);

		// 401, not 403 — the house style for this router's role gates, matching
		// the existing PATCH .../role route verbatim.
		expect(res?.status).toBe(401);

		const row = await dbOps
			.getAdapter()
			.get<StoredRestrictions>(
				"SELECT allowed_accounts, allowed_models, allowed_providers FROM api_keys WHERE id = ?",
				[targetId],
			);
		expect(row?.allowed_accounts).toBeNull();
	});

	it("refuses an unauthenticated request", async () => {
		const url = new URL(
			`http://localhost/api/api-keys/${targetId}/restrictions`,
		);
		const res = await router.handleRequest(
			url,
			new Request(url, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					allowedAccounts: ["acc-1"],
					allowedModels: null,
					allowedProviders: null,
				}),
			}),
		);
		expect(res?.status).toBe(401);
	});
});
