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

	const seedOldRequests = async (n: number) => {
		const old = Date.now() - 60_000;
		for (let i = 0; i < n; i++) {
			await dbOps.getAdapter().run(
				`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, error_message, response_time_ms, failover_attempts)
					 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
				[`old-${i}`, old],
			);
		}
	};

	it("fires exactly once when cleanupOldRequests removes request rows", async () => {
		await seedOldRequests(3);
		let calls = 0;
		dbOps.onRequestsDeleted(() => {
			calls++;
		});
		const res = await dbOps.cleanupOldRequests(1000, 1000);
		expect(res.removedRequests).toBe(3);
		expect(calls).toBe(1);
	});

	it("does not fire when cleanup removes nothing", async () => {
		let calls = 0;
		dbOps.onRequestsDeleted(() => {
			calls++;
		});
		const res = await dbOps.cleanupOldRequests(1000, 1000);
		expect(res.removedRequests).toBe(0);
		expect(calls).toBe(0);
	});

	it("fires and rethrows the original error when the request pass throws after deleting rows", async () => {
		await seedOldRequests(2);
		let calls = 0;
		dbOps.onRequestsDeleted(() => {
			calls++;
		});
		// Smallest seam: the request-metadata repository pass. Delete for real,
		// then fail, as a batched delete does when a later batch errors.
		// biome-ignore lint/suspicious/noExplicitAny: test-only access to private repo
		const repo = (dbOps as any).requests;
		const original = repo.deleteOlderThan.bind(repo);
		repo.deleteOlderThan = async (cutoff: number) => {
			await original(cutoff);
			throw new Error("later batch failed");
		};
		await expect(dbOps.cleanupOldRequests(1000, 1000)).rejects.toThrow(
			"later batch failed",
		);
		expect(calls).toBe(1);
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
		await seedOldRequests(1);
		const res = await dbOps.cleanupOldRequests(1000, 1000);
		expect(res.removedRequests).toBe(1);
		expect(calls).toBe(1);
	});
});
