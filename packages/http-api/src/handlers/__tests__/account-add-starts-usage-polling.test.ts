import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import {
	registerPollingRestarter,
	unregisterPollingRestarter,
} from "@better-ccflare/proxy";
import {
	createAccountAddHandler,
	createZaiAccountAddHandler,
} from "../accounts";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-add-starts-polling.db`;
const SERVER_ID = "test-account-add-polling-server";

describe("account add handlers start usage polling for the new account", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;
	let zaiHandler: (req: Request) => Promise<Response>;
	let seen: string[];

	function cleanupDbFiles() {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				const p = `${TEST_DB_PATH}${suffix}`;
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort cleanup
			}
		}
	}

	beforeEach(() => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountAddHandler(dbOps, null as never);
		zaiHandler = createZaiAccountAddHandler(dbOps);
		seen = [];
		registerPollingRestarter(SERVER_ID, async (id: string) => {
			seen.push(id);
			return true;
		});
	});

	afterEach(() => {
		unregisterPollingRestarter(SERVER_ID);
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function makeRequest(body: Record<string, unknown>) {
		return new Request("http://localhost/api/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}) as unknown as Request;
	}

	it("asks the server to start polling with the freshly created account id", async () => {
		const res = await handler(
			makeRequest({
				name: "alpha",
				provider: "anthropic",
				accessToken: "a1",
				refreshToken: "r1",
			}),
		);
		expect(res.status).toBe(200);
		const payload = (await res.json()) as { accountId: string };

		expect(seen).toEqual([payload.accountId]);
	});

	it("does not ask for polling when the add is rejected as a duplicate", async () => {
		const first = await handler(
			makeRequest({
				name: "beta",
				provider: "anthropic",
				accessToken: "a1",
				refreshToken: "r1",
			}),
		);
		expect(first.status).toBe(200);
		expect(seen).toHaveLength(1);

		const second = await handler(
			makeRequest({
				name: "beta",
				provider: "anthropic",
				accessToken: "a2",
				refreshToken: "r2",
			}),
		);
		expect(second.status).toBe(400);
		// No extra restarter call for the rejected add.
		expect(seen).toHaveLength(1);
	});

	it("also asks for the z.ai add path, whose provider the server will decline", async () => {
		const res = await zaiHandler(
			makeRequest({ name: "zeta", apiKey: "sk-zai-test-key", priority: 0 }),
		);
		expect(res.status).toBe(200);
		const payload = (await res.json()) as { account: { id: string } };

		expect(seen).toEqual([payload.account.id]);
	});
});
