import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { cleanupTempDbs, tempDbPath } from "../__test-utils__/temp-db";
import { DatabaseOperations } from "../database-operations";

// biome-ignore lint/suspicious/noExplicitAny: test reaches into private fields
type Internals = any;

describe("DatabaseOperations.getTableRowCounts cache", () => {
	let dbOps: DatabaseOperations;
	let sumQueries: number;
	let clock: number;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tempDbPath("test-rowcounts"));
		const internals = dbOps as Internals;
		clock = 1_000_000;
		internals.tableCountsClock = () => clock;
		sumQueries = 0;
		const adapter = internals.adapter;
		const origGet = adapter.get.bind(adapter);
		adapter.get = (sql: string, ...rest: unknown[]) => {
			// The payload size scan is the only query aliasing `dataBytes`;
			// the per-table row count aliases `rowCount`.
			if (sql.includes("AS dataBytes")) sumQueries++;
			return origGet(sql, ...rest);
		};
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	afterAll(cleanupTempDbs);

	it("does not re-run the payload size scan within the TTL", async () => {
		const a = await dbOps.getTableRowCounts();
		const b = await dbOps.getTableRowCounts();
		expect(sumQueries).toBe(1);
		expect(b).toEqual(a);
		expect(a.some((t) => t.name === "request_payloads")).toBe(true);
	});

	it("dedupes concurrent calls", async () => {
		await Promise.all([
			dbOps.getTableRowCounts(),
			dbOps.getTableRowCounts(),
			dbOps.getTableRowCounts(),
		]);
		expect(sumQueries).toBe(1);
	});

	it("reloads after the TTL expires", async () => {
		await dbOps.getTableRowCounts();
		clock += 61_000;
		await dbOps.getTableRowCounts();
		expect(sumQueries).toBe(2);
	});

	it("reloads after cleanupOldRequests invalidates the cache", async () => {
		await dbOps.getTableRowCounts();
		await dbOps.cleanupOldRequests(0, 0);
		await dbOps.getTableRowCounts();
		expect(sumQueries).toBe(2);
	});
});
