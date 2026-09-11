import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createAccountRequestTransformerUpdateHandler } from "../accounts";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-request-transformer-update.db`;

function cleanupDbFiles(): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		const path = `${TEST_DB_PATH}${suffix}`;
		if (existsSync(path)) unlinkSync(path);
	}
}

function requestWith(requestTransformer: unknown): Request {
	return new Request("http://localhost/api/accounts/x/request-transformer", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ requestTransformer }),
	});
}

async function insertAccount(
	dbOps: DatabaseOperations,
	provider: string,
): Promise<string> {
	const id = crypto.randomUUID();
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[id, id, provider, "token", Date.now(), 0],
	);
	return id;
}

async function storedValue(
	dbOps: DatabaseOperations,
	id: string,
): Promise<string | null> {
	const row = await dbOps.getAdapter().get<{
		request_transformer: string | null;
	}>("SELECT request_transformer FROM accounts WHERE id = ?", [id]);
	return row?.request_transformer ?? null;
}

describe("createAccountRequestTransformerUpdateHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: ReturnType<typeof createAccountRequestTransformerUpdateHandler>;

	beforeAll(() => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountRequestTransformerUpdateHandler(dbOps);
	});

	afterAll(() => {
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	beforeEach(async () => {
		await dbOps.getAdapter().run("DELETE FROM accounts", []);
	});

	it("stores the supported transformer for an OpenAI-compatible account", async () => {
		const id = await insertAccount(dbOps, "openai-compatible");

		expect(
			(await handler(requestWith("max-tokens-to-max-completion-tokens"), id))
				.status,
		).toBe(200);
		expect(await storedValue(dbOps, id)).toBe(
			"max-tokens-to-max-completion-tokens",
		);
	});

	it("clears the transformer when sent null", async () => {
		const id = await insertAccount(dbOps, "openai-compatible");
		await handler(requestWith("max-tokens-to-max-completion-tokens"), id);

		expect((await handler(requestWith(null), id)).status).toBe(200);
		expect(await storedValue(dbOps, id)).toBeNull();
	});

	it("rejects an unsupported transformer", async () => {
		const id = await insertAccount(dbOps, "openai-compatible");

		expect((await handler(requestWith("unknown"), id)).status).toBe(400);
	});

	it("rejects a transformer for a non-OpenAI-compatible account", async () => {
		const id = await insertAccount(dbOps, "anthropic");

		expect(
			(await handler(requestWith("max-tokens-to-max-completion-tokens"), id))
				.status,
		).toBe(400);
	});

	it("returns not found for a missing account", async () => {
		expect((await handler(requestWith(null), "missing")).status).toBe(404);
	});
});
