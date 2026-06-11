import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";

const EXPECTED_ALERT_COLUMNS = [
	"id",
	"timestamp",
	"type",
	"severity",
	"title",
	"message",
	"value",
	"threshold",
	"account",
	"model",
	"project",
	"request_id",
	"acknowledged",
];

describe("Alerts Table Migration (issue #250)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("creates the alerts table with expected columns on a fresh database", () => {
		ensureSchema(db);
		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(alerts)").all() as Array<{
			name: string;
			type: string;
			notnull: number;
		}>;
		const columnNames = columns.map((col) => col.name);

		for (const expected of EXPECTED_ALERT_COLUMNS) {
			expect(columnNames).toContain(expected);
		}
	});

	it("uses the expected column types and constraints", () => {
		ensureSchema(db);

		const columns = db.prepare("PRAGMA table_info(alerts)").all() as Array<{
			name: string;
			type: string;
			notnull: number;
			pk: number;
		}>;
		const byName = new Map(columns.map((col) => [col.name, col]));

		expect(byName.get("id")?.pk).toBe(1);
		expect(byName.get("timestamp")?.type.toUpperCase()).toBe("INTEGER");
		expect(byName.get("timestamp")?.notnull).toBe(1);
		expect(byName.get("type")?.notnull).toBe(1);
		expect(byName.get("severity")?.notnull).toBe(1);
		expect(byName.get("title")?.notnull).toBe(1);
		expect(byName.get("message")?.notnull).toBe(1);
		expect(byName.get("value")?.type.toUpperCase()).toBe("REAL");
		expect(byName.get("threshold")?.type.toUpperCase()).toBe("REAL");
		expect(byName.get("acknowledged")?.type.toUpperCase()).toBe("INTEGER");
		expect(byName.get("acknowledged")?.notnull).toBe(1);
	});

	it("creates the alerts indexes", () => {
		ensureSchema(db);

		const indexes = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'alerts'",
			)
			.all() as Array<{ name: string }>;
		const indexNames = indexes.map((idx) => idx.name);

		expect(indexNames).toContain("idx_alerts_timestamp");
		expect(indexNames).toContain("idx_alerts_acknowledged");
	});

	it("adds the alerts table when upgrading an existing pre-alerts database", () => {
		// Simulate an existing install: full schema except the alerts table.
		ensureSchema(db);
		db.run("DROP TABLE alerts");

		runMigrations(db);

		const columns = db.prepare("PRAGMA table_info(alerts)").all() as Array<{
			name: string;
		}>;
		const columnNames = columns.map((col) => col.name);
		for (const expected of EXPECTED_ALERT_COLUMNS) {
			expect(columnNames).toContain(expected);
		}
	});

	it("stores and reads back an alert row with defaults applied", () => {
		ensureSchema(db);

		db.prepare(`
			INSERT INTO alerts (id, timestamp, type, severity, title, message)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(
			"alert-1",
			1717900000000,
			"daily_spend",
			"warning",
			"Daily spend threshold exceeded",
			"Spend reached $12.50 of $10.00 limit",
		);

		const row = db
			.prepare(
				"SELECT id, timestamp, type, severity, value, threshold, account, acknowledged FROM alerts WHERE id = ?",
			)
			.get("alert-1") as {
			id: string;
			timestamp: number;
			type: string;
			severity: string;
			value: number | null;
			threshold: number | null;
			account: string | null;
			acknowledged: number;
		};

		expect(row.id).toBe("alert-1");
		expect(row.timestamp).toBe(1717900000000);
		expect(row.type).toBe("daily_spend");
		expect(row.severity).toBe("warning");
		expect(row.value).toBeNull();
		expect(row.threshold).toBeNull();
		expect(row.account).toBeNull();
		expect(row.acknowledged).toBe(0);
	});
});
