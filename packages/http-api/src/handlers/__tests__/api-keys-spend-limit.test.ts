/**
 * PATCH /api/api-keys/:idOrName/limit, the spend-limit half of
 * POST /api/api-keys, and the spend fields on GET /api/api-keys.
 *
 * The invariant these are about: `limitUsd: null` means NO LIMIT and clears
 * the window and enforcement with it, a MISSING limitUsd on PATCH is a
 * malformed request rather than a clear, and nothing between the request body
 * and the stored column is allowed to coerce a string into a budget.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { resetApiKeySpendCounter } from "@better-ccflare/proxy";
import { NodeCryptoUtils } from "@better-ccflare/types";
import { APIRouter } from "../../router";
import type { APIContext } from "../../types";
import {
	createApiKeysGenerateHandler,
	createApiKeysListHandler,
	createApiKeyUpdateSpendLimitHandler,
} from "../api-keys";

// One database file per describe block: sharing a path across blocks lets one
// block's cleanup race the next block's open.
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

interface StoredLimit {
	limit_usd: number | null;
	limit_window: string | null;
	limit_enforce: string | null;
}

describe("PATCH /api/api-keys/:idOrName/limit", () => {
	const TEST_DB_PATH = `${TEST_DB_ROOT}/test-api-key-spend-limit-patch.db`;
	let dbOps: DatabaseOperations;
	let handler: (req: Request, keyIdOrName: string) => Promise<Response>;
	let keyId: string;

	beforeEach(async () => {
		cleanupDbFiles(TEST_DB_PATH);
		resetApiKeySpendCounter();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createApiKeyUpdateSpendLimitHandler(dbOps);

		keyId = crypto.randomUUID();
		await dbOps.createApiKey({
			id: keyId,
			name: "budgeted-key",
			hashedKey: `hash-${keyId}`,
			prefixLast8: "abcdefgh",
			createdAt: Date.now(),
			isActive: true,
			role: "admin",
		});
	});

	afterEach(async () => {
		// DatabaseOperations starts a multi-instance heartbeat loop that is
		// never awaited by anything. Closing the database out from under an
		// in-flight tick turns it into an unhandled rejection attributed to
		// whichever test happens to be running next, so let it settle first.
		// Harness-only: nothing in the product waits on that write. Same
		// workaround the sibling restrictions test file uses in its gate block.
		await new Promise((resolve) => setTimeout(resolve, 50));
		DatabaseFactory.reset();
		resetApiKeySpendCounter();
		cleanupDbFiles(TEST_DB_PATH);
	});

	function makeRequest(body: unknown): Request {
		return new Request(`http://localhost/api/api-keys/${keyId}/limit`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function stored(): Promise<StoredLimit | null> {
		const row = await dbOps
			.getAdapter()
			.get<StoredLimit>(
				"SELECT limit_usd, limit_window, limit_enforce FROM api_keys WHERE id = ?",
				[keyId],
			);
		return row ?? null;
	}

	it("starts with no limit: all three columns NULL", async () => {
		expect(await stored()).toEqual({
			limit_usd: null,
			limit_window: null,
			limit_enforce: null,
		});
	});

	it("round-trips a limit", async () => {
		const res = await handler(
			makeRequest({
				limitUsd: 250.5,
				limitWindow: "calendar_month",
				limitEnforce: "warn",
			}),
			keyId,
		);

		expect(res.status).toBe(200);
		expect(await stored()).toEqual({
			limit_usd: 250.5,
			limit_window: "calendar_month",
			limit_enforce: "warn",
		});

		const key = await dbOps.getApiKey(keyId);
		expect(key?.limitUsd).toBe(250.5);
		expect(key?.limitWindow).toBe("calendar_month");
		expect(key?.limitEnforce).toBe("warn");
	});

	it("applies the documented defaults when window and enforcement are null", async () => {
		const res = await handler(
			makeRequest({ limitUsd: 10, limitWindow: null, limitEnforce: null }),
			keyId,
		);

		expect(res.status).toBe(200);
		expect(await stored()).toEqual({
			limit_usd: 10,
			limit_window: "rolling_30d",
			limit_enforce: "block",
		});
	});

	it("clears the limit AND its window and enforcement on null", async () => {
		await handler(
			makeRequest({
				limitUsd: 10,
				limitWindow: "rolling_7d",
				limitEnforce: "warn",
			}),
			keyId,
		);

		const res = await handler(makeRequest({ limitUsd: null }), keyId);
		expect(res.status).toBe(200);
		// A stale window left behind would make a later "set $50" silently
		// inherit a window the operator set months ago.
		expect(await stored()).toEqual({
			limit_usd: null,
			limit_window: null,
			limit_enforce: null,
		});
	});

	it("rejects a missing limitUsd rather than treating it as a clear", async () => {
		await handler(makeRequest({ limitUsd: 10 }), keyId);

		const res = await handler(
			makeRequest({ limitWindow: "rolling_7d" }),
			keyId,
		);
		expect(res.status).toBe(400);
		expect((await stored())?.limit_usd).toBe(10);
	});

	it("rejects a numeric STRING — validateNumber would have coerced it", async () => {
		// The repo's core `validateNumber` accepts "200" as 200. This endpoint
		// does not, matching the sibling account plan-price handler: a budget
		// arriving as a string is a caller bug worth surfacing.
		const res = await handler(makeRequest({ limitUsd: "200" }), keyId);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("limitUsd");
		expect((await stored())?.limit_usd).toBeNull();
	});

	it("rejects zero", async () => {
		const res = await handler(makeRequest({ limitUsd: 0 }), keyId);
		expect(res.status).toBe(400);
		expect((await stored())?.limit_usd).toBeNull();
	});

	it("rejects a negative limit", async () => {
		const res = await handler(makeRequest({ limitUsd: -5 }), keyId);
		expect(res.status).toBe(400);
		expect((await stored())?.limit_usd).toBeNull();
	});

	it("rejects ±Infinity, which a JSON body CAN carry", async () => {
		// Infinity does not survive JSON.stringify (it becomes `null`), so the
		// body is written by hand: `1e999` is an overflowing literal, which
		// JSON.parse accepts and turns into Infinity. That reaches the
		// validator as a real number and must be a 400 — a stored ±Infinity
		// could never be compared against a spend total.
		//
		// A literal `NaN` is deliberately NOT tested here: it is not valid
		// JSON at all, so such a body fails to parse and never reaches this
		// validation. `Number.isFinite` still guards against it, and that is
		// the same branch these two take.
		for (const literal of ["1e999", "-1e999"]) {
			const req = new Request(`http://localhost/api/api-keys/${keyId}/limit`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: `{"limitUsd": ${literal}}`,
			});
			const res = await handler(req, keyId);
			expect(res.status).toBe(400);
		}
		expect((await stored())?.limit_usd).toBeNull();
	});

	it("rejects a boolean and an object", async () => {
		for (const raw of [true, { amount: 10 }]) {
			const res = await handler(makeRequest({ limitUsd: raw }), keyId);
			expect(res.status).toBe(400);
		}
		expect((await stored())?.limit_usd).toBeNull();
	});

	it("rejects an unknown window", async () => {
		const res = await handler(
			makeRequest({ limitUsd: 10, limitWindow: "rolling_90d" }),
			keyId,
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("limitWindow");
		expect((await stored())?.limit_usd).toBeNull();
	});

	it("rejects an unknown enforcement mode", async () => {
		const res = await handler(
			makeRequest({ limitUsd: 10, limitEnforce: "throttle" }),
			keyId,
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("limitEnforce");
	});

	it("does not trim or case-fold enum values", async () => {
		// These are machine values from a <select>, not human input; accepting
		// "Block " would make the stored value depend on the client.
		for (const enforce of ["Block", "block "]) {
			const res = await handler(
				makeRequest({ limitUsd: 10, limitEnforce: enforce }),
				keyId,
			);
			expect(res.status).toBe(400);
		}
	});

	it("accepts a key NAME as well as an id", async () => {
		const res = await handler(makeRequest({ limitUsd: 42 }), "budgeted-key");
		expect(res.status).toBe(200);
		expect((await stored())?.limit_usd).toBe(42);
	});

	it("404s for an unknown key", async () => {
		const res = await handler(makeRequest({ limitUsd: 42 }), "no-such-key");
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect((await stored())?.limit_usd).toBeNull();
	});
});

describe("POST /api/api-keys — spend limit at creation", () => {
	const TEST_DB_PATH = `${TEST_DB_ROOT}/test-api-key-spend-limit-create.db`;
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeEach(() => {
		cleanupDbFiles(TEST_DB_PATH);
		resetApiKeySpendCounter();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createApiKeysGenerateHandler(dbOps);
	});

	afterEach(async () => {
		// See the PATCH block above: let the un-awaited heartbeat write settle
		// before closing the database, or it surfaces as an unhandled
		// rejection attributed to an unrelated test.
		await new Promise((resolve) => setTimeout(resolve, 50));
		DatabaseFactory.reset();
		resetApiKeySpendCounter();
		cleanupDbFiles(TEST_DB_PATH);
	});

	function makeCreateRequest(body: unknown): Request {
		return new Request("http://localhost/api/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("creates a key with no limit when the field is omitted", async () => {
		const res = await handler(
			makeCreateRequest({ name: "plain", role: "admin" }),
		);
		expect(res.status).toBe(201);

		const key = await dbOps.getApiKeyByName("plain");
		expect(key?.limitUsd).toBeNull();
		expect(key?.limitWindow).toBeNull();
		expect(key?.limitEnforce).toBeNull();
	});

	it("stores a limit supplied at creation", async () => {
		const res = await handler(
			makeCreateRequest({
				name: "budgeted",
				role: "admin",
				limitUsd: 30,
				limitWindow: "rolling_7d",
				limitEnforce: "warn",
			}),
		);
		expect(res.status).toBe(201);

		const key = await dbOps.getApiKeyByName("budgeted");
		expect(key?.limitUsd).toBe(30);
		expect(key?.limitWindow).toBe("rolling_7d");
		expect(key?.limitEnforce).toBe("warn");
	});

	it("rejects an invalid limit at creation and creates nothing", async () => {
		const res = await handler(
			makeCreateRequest({ name: "bad", role: "admin", limitUsd: -1 }),
		);
		expect(res.status).toBe(400);
		expect(await dbOps.getApiKeyByName("bad")).toBeNull();
	});
});

describe("GET /api/api-keys — spend fields on the list", () => {
	const TEST_DB_PATH = `${TEST_DB_ROOT}/test-api-key-spend-limit-list.db`;
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		cleanupDbFiles(TEST_DB_PATH);
		resetApiKeySpendCounter();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(async () => {
		// See the PATCH block above: let the un-awaited heartbeat write settle
		// before closing the database, or it surfaces as an unhandled
		// rejection attributed to an unrelated test.
		await new Promise((resolve) => setTimeout(resolve, 50));
		DatabaseFactory.reset();
		resetApiKeySpendCounter();
		cleanupDbFiles(TEST_DB_PATH);
	});

	async function listed(): Promise<
		Array<{
			name: string;
			limitUsd: number | null;
			spentUsd?: number;
			windowResetsAt?: string | null;
		}>
	> {
		const res = await createApiKeysListHandler(dbOps)();
		const body = (await res.json()) as {
			data: Array<{
				name: string;
				limitUsd: number | null;
				spentUsd?: number;
				windowResetsAt?: string | null;
			}>;
		};
		return body.data;
	}

	it("carries the limit fields plus live spend for a limited key", async () => {
		const id = crypto.randomUUID();
		await dbOps.createApiKey({
			id,
			name: "budgeted",
			hashedKey: `hash-${id}`,
			prefixLast8: "12345678",
			createdAt: Date.now(),
			isActive: true,
			role: "admin",
			spendLimit: {
				limitUsd: 100,
				limitWindow: "calendar_month",
				limitEnforce: "block",
			},
		});

		const rows = await listed();
		const row = rows.find((r) => r.name === "budgeted");
		expect(row?.limitUsd).toBe(100);
		// No requests recorded, so the counter reports zero spend — and a
		// calendar window always knows when it resets.
		expect(row?.spentUsd).toBe(0);
		expect(typeof row?.windowResetsAt).toBe("string");
	});

	it("attaches nothing to a key with no limit", async () => {
		const id = crypto.randomUUID();
		await dbOps.createApiKey({
			id,
			name: "plain",
			hashedKey: `hash-${id}`,
			prefixLast8: "87654321",
			createdAt: Date.now(),
			isActive: true,
			role: "admin",
		});

		const rows = await listed();
		const row = rows.find((r) => r.name === "plain");
		expect(row?.limitUsd).toBeNull();
		expect(row?.spentUsd).toBeUndefined();
		expect(row?.windowResetsAt).toBeUndefined();
	});
});

describe("PATCH /api/api-keys/:idOrName/limit — admin gate", () => {
	const TEST_DB_PATH = `${TEST_DB_ROOT}/test-api-key-spend-limit-gate.db`;
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
		resetApiKeySpendCounter();
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
		// it; closing the database out from under that write turns it into an
		// unhandled rejection between test files. Harness-only.
		await new Promise((resolve) => setTimeout(resolve, 50));
		DatabaseFactory.reset();
		resetApiKeySpendCounter();
		cleanupDbFiles(TEST_DB_PATH);
	});

	function patch(apiKey: string): { url: URL; req: Request } {
		const url = new URL(`http://localhost/api/api-keys/${targetId}/limit`);
		const req = new Request(url, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "x-api-key": apiKey },
			body: JSON.stringify({
				limitUsd: 75,
				limitWindow: "rolling_30d",
				limitEnforce: "block",
			}),
		});
		return { url, req };
	}

	async function storedLimit(): Promise<number | null> {
		const row = await dbOps
			.getAdapter()
			.get<StoredLimit>("SELECT limit_usd FROM api_keys WHERE id = ?", [
				targetId,
			]);
		return row?.limit_usd ?? null;
	}

	it("lets an admin key set a spend limit", async () => {
		const { url, req } = patch(adminKey);
		const res = await router.handleRequest(url, req);
		expect(res?.status).toBe(200);
		expect(await storedLimit()).toBe(75);
	});

	it("refuses an api-only key, and writes nothing", async () => {
		const { url, req } = patch(apiOnlyKey);
		const res = await router.handleRequest(url, req);

		// 401, not 403 — the house style for this router's role gates, matching
		// the /role and /restrictions routes verbatim.
		expect(res?.status).toBe(401);
		expect(await storedLimit()).toBeNull();
	});

	it("refuses an unauthenticated request", async () => {
		const url = new URL(`http://localhost/api/api-keys/${targetId}/limit`);
		const res = await router.handleRequest(
			url,
			new Request(url, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ limitUsd: 75 }),
			}),
		);
		expect(res?.status).toBe(401);
		expect(await storedLimit()).toBeNull();
	});
});
