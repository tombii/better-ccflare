import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import {
	createApiKeyDeleteHandler,
	createApiKeyDisableHandler,
	createApiKeyEnableHandler,
	createApiKeyUpdateRoleHandler,
} from "../api-keys";

describe("API key role and lifecycle mutations", () => {
	const dbPath = `${process.env.TMPDIR || "/tmp"}/test-api-key-mutations.db`;
	let dbOps: DatabaseOperations;
	let keyId: string;

	function cleanupDbFiles() {
		for (const suffix of ["", "-wal", "-shm"]) {
			const path = `${dbPath}${suffix}`;
			if (existsSync(path)) unlinkSync(path);
		}
	}

	beforeEach(async () => {
		cleanupDbFiles();
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
		keyId = crypto.randomUUID();
		await dbOps.createApiKey({
			id: keyId,
			name: "target-key",
			hashedKey: `hash-${keyId}`,
			prefixLast8: "abcdefgh",
			createdAt: Date.now(),
			isActive: true,
			role: "api-only",
		});
	});

	afterEach(() => {
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function roleRequest(body: string) {
		return new Request(`http://localhost/api/api-keys/${keyId}/role`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body,
		});
	}

	async function createNameCollision() {
		const collisionId = crypto.randomUUID();
		await dbOps.createApiKey({
			id: collisionId,
			name: keyId,
			hashedKey: `hash-${collisionId}`,
			prefixLast8: "ijklmnop",
			createdAt: Date.now(),
			isActive: true,
			role: "api-only",
		});
		return collisionId;
	}

	for (const body of ["{", "null", "[]", '"admin"']) {
		it(`returns 400 without changing the role for body ${body}`, async () => {
			const res = await createApiKeyUpdateRoleHandler(dbOps)(
				roleRequest(body),
				keyId,
			);
			expect(res.status).toBe(400);
			expect((await dbOps.getApiKey(keyId))?.role).toBe("api-only");
		});
	}

	it("returns 404 for a missing role target", async () => {
		const res = await createApiKeyUpdateRoleHandler(dbOps)(
			roleRequest('{"role":"admin"}'),
			"no-such-key",
		);
		expect(res.status).toBe(404);
	});

	it("does not resolve a role target by name", async () => {
		const res = await createApiKeyUpdateRoleHandler(dbOps)(
			roleRequest('{"role":"admin"}'),
			"target-key",
		);
		expect(res.status).toBe(404);
		expect((await dbOps.getApiKey(keyId))?.role).toBe("api-only");
	});

	it("updates a role by ID when another key's name matches that ID", async () => {
		const collisionId = await createNameCollision();
		const otherKey = await dbOps.getApiKey(collisionId);
		const res = await createApiKeyUpdateRoleHandler(dbOps)(
			roleRequest('{"role":"admin"}'),
			keyId,
		);
		expect(res.status).toBe(200);
		expect((await dbOps.getApiKey(keyId))?.role).toBe("admin");
		expect(await dbOps.getApiKey(collisionId)).toEqual(otherKey);
	});

	it("keeps the currently authenticated key's role unchanged", async () => {
		const res = await createApiKeyUpdateRoleHandler(dbOps)(
			roleRequest('{"role":"admin"}'),
			keyId,
			keyId,
		);
		expect(res.status).toBe(500);
		expect((await dbOps.getApiKey(keyId))?.role).toBe("api-only");
	});

	for (const [action, factory] of [
		["disable", createApiKeyDisableHandler],
		["enable", createApiKeyEnableHandler],
		["delete", createApiKeyDeleteHandler],
	] as const) {
		it(`returns 404 for a missing ${action} target`, async () => {
			const res = await factory(dbOps)(
				new Request("http://localhost/api/api-keys/no-such-key", {
					method: action === "delete" ? "DELETE" : "POST",
				}),
				"no-such-key",
			);
			expect(res.status).toBe(404);
		});

		it(`${action}s a key by name without a request body`, async () => {
			if (action === "enable") await dbOps.disableApiKey(keyId);
			const res = await factory(dbOps)(
				new Request("http://localhost/api/api-keys/target-key", {
					method: action === "delete" ? "DELETE" : "POST",
				}),
				"target-key",
			);
			expect(res.status).toBe(200);
			const key = await dbOps.getApiKey(keyId);
			if (action === "delete") expect(key).toBeNull();
			else expect(key?.isActive).toBe(action === "enable");
		});

		it(`does not resolve a ${action} target by ID`, async () => {
			if (action === "enable") await dbOps.disableApiKey(keyId);
			const originalKey = await dbOps.getApiKey(keyId);
			const res = await factory(dbOps)(
				new Request(`http://localhost/api/api-keys/${keyId}`, {
					method: action === "delete" ? "DELETE" : "POST",
				}),
				keyId,
			);
			expect(res.status).toBe(404);
			expect(await dbOps.getApiKey(keyId)).toEqual(originalKey);
		});

		it(`${action}s only the named key when its name matches another key's ID`, async () => {
			const collisionId = await createNameCollision();
			if (action === "enable") {
				await dbOps.disableApiKey(keyId);
				await dbOps.disableApiKey(collisionId);
			}
			const otherKey = await dbOps.getApiKey(keyId);
			const res = await factory(dbOps)(
				new Request(`http://localhost/api/api-keys/${keyId}`, {
					method: action === "delete" ? "DELETE" : "POST",
				}),
				keyId,
			);
			expect(res.status).toBe(200);
			const namedKey = await dbOps.getApiKey(collisionId);
			if (action === "delete") expect(namedKey).toBeNull();
			else expect(namedKey?.isActive).toBe(action === "enable");
			expect(await dbOps.getApiKey(keyId)).toEqual(otherKey);
		});
	}
});
