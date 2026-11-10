/**
 * `requests.completion_tier` (SQLite): the provider-reported tier a request
 * actually ran on. Must be added to the initial schema AND to the guarded
 * ALTER list so a pre-existing database gains it, default to NULL, and round
 * trip through the request repository.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "./migrations";
import { RequestRepository } from "./repositories/request.repository";

interface ColumnInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
}

function requestColumns(db: Database): ColumnInfo[] {
	return db.prepare("PRAGMA table_info(requests)").all() as ColumnInfo[];
}

describe("requests.completion_tier migration (SQLite)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("ensureSchema creates a nullable TEXT completion_tier column", () => {
		ensureSchema(db);

		const column = requestColumns(db).find((c) => c.name === "completion_tier");
		expect(column).toBeDefined();
		expect(column?.type.toUpperCase()).toBe("TEXT");
		expect(column?.notnull).toBe(0);
		expect(column?.dflt_value).toBeNull();
	});

	it("runMigrations adds completion_tier to a legacy requests table", () => {
		// Simulate a pre-existing database without the column. Mirrors
		// ensureSchema's older shape rather than calling it, which already
		// includes the column under test.
		db.run(`
			CREATE TABLE requests (
				id TEXT PRIMARY KEY,
				timestamp INTEGER NOT NULL,
				method TEXT NOT NULL,
				path TEXT NOT NULL,
				account_used TEXT,
				status_code INTEGER,
				success BOOLEAN,
				error_message TEXT,
				response_time_ms INTEGER,
				failover_attempts INTEGER DEFAULT 0
			)
		`);
		db.prepare(
			"INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, ?, ?)",
		).run("legacy-tier", Date.now(), "POST", "/v1/messages");

		expect(() => runMigrations(db)).not.toThrow();

		const column = requestColumns(db).find((c) => c.name === "completion_tier");
		expect(column?.type.toUpperCase()).toBe("TEXT");
		expect(column?.notnull).toBe(0);
		expect(column?.dflt_value).toBeNull();

		// Existing rows get NULL, not a fabricated default.
		const row = db
			.prepare("SELECT completion_tier FROM requests WHERE id = ?")
			.get("legacy-tier") as { completion_tier: string | null };
		expect(row.completion_tier).toBeNull();

		// Idempotent: a second run must not throw or duplicate the column.
		expect(() => runMigrations(db)).not.toThrow();
		expect(
			requestColumns(db).filter((c) => c.name === "completion_tier"),
		).toHaveLength(1);
	});

	it("persists and reads back completion_tier through the repository", async () => {
		ensureSchema(db);
		runMigrations(db);
		const repo = new RequestRepository(new BunSqlAdapter(db));

		await repo.save({
			id: "tier-roundtrip",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 12,
			failoverAttempts: 0,
			usage: {
				model: "sail-model",
				outputTokens: 5,
				completionTier: "balanced",
			},
		});

		const row = db
			.prepare("SELECT completion_tier FROM requests WHERE id = ?")
			.get("tier-roundtrip") as { completion_tier: string | null };
		expect(row.completion_tier).toBe("balanced");

		// A later update without the field must not blank it out (COALESCE).
		await repo.updateUsage("tier-roundtrip", { promptTokens: 3 });
		const after = db
			.prepare("SELECT completion_tier FROM requests WHERE id = ?")
			.get("tier-roundtrip") as { completion_tier: string | null };
		expect(after.completion_tier).toBe("balanced");
	});

	it("leaves completion_tier NULL when the provider reported no tier", async () => {
		ensureSchema(db);
		runMigrations(db);
		const repo = new RequestRepository(new BunSqlAdapter(db));

		await repo.save({
			id: "tier-absent",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 12,
			failoverAttempts: 0,
			usage: { model: "sail-model", outputTokens: 5 },
		});

		const row = db
			.prepare("SELECT completion_tier FROM requests WHERE id = ?")
			.get("tier-absent") as { completion_tier: string | null };
		expect(row.completion_tier).toBeNull();
	});
});
