import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "../database-operations";

describe("DatabaseOperations.onRequestsDeleted", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbOps = new DatabaseOperations(
			join(
				tmpdir(),
				`test-deleted-listener-${randomBytes(6).toString("hex")}.db`,
			),
		);
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	it("fires after cleanupOldRequests", async () => {
		let calls = 0;
		dbOps.onRequestsDeleted(() => {
			calls++;
		});
		await dbOps.cleanupOldRequests(1000, 1000);
		expect(calls).toBeGreaterThanOrEqual(1);
	});

	it("stops firing after unsubscribe", async () => {
		let calls = 0;
		const off = dbOps.onRequestsDeleted(() => {
			calls++;
		});
		off();
		await dbOps.cleanupOldRequests(1000, 1000);
		expect(calls).toBe(0);
	});

	it("a throwing listener does not break cleanup or other listeners", async () => {
		let calls = 0;
		dbOps.onRequestsDeleted(() => {
			throw new Error("boom");
		});
		dbOps.onRequestsDeleted(() => {
			calls++;
		});
		const res = await dbOps.cleanupOldRequests(1000, 1000);
		expect(res).toEqual({ removedRequests: 0, removedPayloads: 0 });
		expect(calls).toBeGreaterThanOrEqual(1);
	});
});
