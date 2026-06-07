/**
 * Integration tests for compressed payload persistence in RequestRepository.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function insertRequest(db: Database, id: string): void {
	db.run(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, NULL, 100, 0)`,
		[id, Date.now()],
	);
}

describe("RequestRepository compressed payloads", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("persists and retrieves a compressed payload round-trip", async () => {
		insertRequest(db, "req-compressed");
		const payload = {
			request: {
				headers: { "content-type": "application/json" },
				body: "e30=",
			},
			response: { status: 200, headers: {}, body: null },
			meta: { success: true },
		};
		await repo.savePayload("req-compressed", payload);

		const row = db
			.query("SELECT json, compressed FROM request_payloads WHERE id = ?")
			.get("req-compressed") as { json: string; compressed: number };
		expect(row.compressed).toBe(1);
		expect(row.json).not.toContain('"request"');

		const loaded = await repo.getPayload("req-compressed");
		expect(loaded).toEqual(payload);
	});

	it("reads legacy uncompressed payload rows", async () => {
		insertRequest(db, "req-legacy");
		const legacyJson = JSON.stringify({ request: { body: null }, meta: {} });
		db.run(
			`INSERT INTO request_payloads (id, json, timestamp, compressed) VALUES (?, ?, ?, 0)`,
			["req-legacy", legacyJson, Date.now()],
		);

		const loaded = await repo.getPayload("req-legacy");
		expect(loaded).toEqual({ request: { body: null }, meta: {} });
	});

	it("returns null for requests without a payload row", async () => {
		insertRequest(db, "req-no-payload");
		expect(await repo.getPayload("req-no-payload")).toBeNull();
	});

	it("list endpoint decrypts compressed payloads without affecting summary queries", async () => {
		insertRequest(db, "req-list");
		await repo.savePayloadRaw(
			"req-list",
			JSON.stringify({ request: { body: "x" }, response: { body: "y" } }),
		);

		const listed = await repo.listPayloadsWithAccountNames(10);
		const row = listed.find((r) => r.id === "req-list");
		expect(row).toBeDefined();
		expect(row?.json).toContain('"request"');
	});

	it("deletePayloadsOlderThan removes compressed payload rows", async () => {
		const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
		insertRequest(db, "old-req");
		db.run(`UPDATE requests SET timestamp = ? WHERE id = 'old-req'`, [oldTs]);
		await repo.savePayloadRaw("old-req", JSON.stringify({ request: {} }));
		db.run(`UPDATE request_payloads SET timestamp = ? WHERE id = 'old-req'`, [
			oldTs,
		]);

		const removed = await repo.deletePayloadsOlderThan(
			Date.now() - 7 * 24 * 60 * 60 * 1000,
		);
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(
			(
				db.query("SELECT COUNT(*) as n FROM request_payloads").get() as {
					n: number;
				}
			).n,
		).toBe(0);
	});
});
