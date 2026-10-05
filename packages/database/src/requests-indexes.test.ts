/**
 * Index set on the `requests` table (SQLite).
 *
 * 12 redundant/unusable indexes were dropped because every one of them slows
 * each INSERT/UPDATE/DELETE on the hottest table. These tests pin the final
 * set and check that the drop is idempotent on databases that still carry the
 * old indexes.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";
import { REDUNDANT_REQUEST_INDEXES } from "./performance-indexes";

const KEPT_INDEXES = [
	"idx_requests_account_timestamp",
	"idx_requests_analytics_covering",
	"idx_requests_api_key_timestamp",
	"idx_requests_model_timestamp",
	"idx_requests_summary_covering",
];

const DROPPED_INDEXES = [
	"idx_requests_timestamp",
	"idx_requests_account_used",
	"idx_requests_timestamp_account",
	"idx_requests_success_timestamp",
	"idx_requests_cost_model",
	"idx_requests_response_time",
	"idx_requests_tokens",
	"idx_requests_api_key",
	"idx_requests_project_timestamp",
	"idx_requests_cleanup",
	"idx_requests_billing_type_timestamp",
	// Created by the old docs/deployment.md instructions, never by the app.
	"idx_requests_account",
];

/** Old (pre-drop) definitions, used to simulate an upgraded database. */
const OLD_INDEX_SQL = [
	"CREATE INDEX idx_requests_timestamp ON requests(timestamp DESC)",
	"CREATE INDEX idx_requests_account_used ON requests(account_used)",
	"CREATE INDEX idx_requests_timestamp_account ON requests(timestamp DESC, account_used)",
	"CREATE INDEX idx_requests_success_timestamp ON requests(success, timestamp DESC)",
	"CREATE INDEX idx_requests_cost_model ON requests(cost_usd, model, timestamp DESC) WHERE cost_usd > 0 AND model IS NOT NULL",
	"CREATE INDEX idx_requests_response_time ON requests(model, response_time_ms) WHERE response_time_ms IS NOT NULL AND model IS NOT NULL",
	"CREATE INDEX idx_requests_tokens ON requests(timestamp DESC, total_tokens) WHERE total_tokens > 0",
	"CREATE INDEX idx_requests_api_key ON requests(api_key_id) WHERE api_key_id IS NOT NULL",
	"CREATE INDEX idx_requests_project_timestamp ON requests(project, timestamp DESC) WHERE project IS NOT NULL",
	"CREATE INDEX idx_requests_cleanup ON requests(timestamp ASC, id)",
	"CREATE INDEX idx_requests_billing_type_timestamp ON requests(billing_type, timestamp DESC) WHERE billing_type IS NOT NULL",
	"CREATE INDEX idx_requests_account ON requests(account_used)",
];

function requestIndexNames(db: Database): string[] {
	return (
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='requests' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
			)
			.all() as Array<{ name: string }>
	).map((r) => r.name);
}

describe("requests indexes: drop of redundant indexes", () => {
	it("REDUNDANT_REQUEST_INDEXES lists exactly the 12 approved names", () => {
		expect([...REDUNDANT_REQUEST_INDEXES].sort()).toEqual(
			[...DROPPED_INDEXES].sort(),
		);
	});

	it("a fresh database has none of the dropped indexes and all kept ones", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const names = requestIndexNames(db);
		for (const dropped of DROPPED_INDEXES) {
			expect(names).not.toContain(dropped);
		}
		for (const kept of KEPT_INDEXES) {
			expect(names).toContain(kept);
		}
		db.close();
	});

	it("drops the old indexes from an upgraded database, idempotently", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		// Columns such as api_key_id/project are added by runMigrations, so run
		// it once, then recreate the old indexes as an upgraded DB would have.
		runMigrations(db);
		for (const sql of OLD_INDEX_SQL) {
			db.run(sql);
		}
		expect(requestIndexNames(db)).toEqual(
			expect.arrayContaining(DROPPED_INDEXES),
		);

		runMigrations(db);
		const afterFirst = requestIndexNames(db);
		for (const dropped of DROPPED_INDEXES) {
			expect(afterFirst).not.toContain(dropped);
		}

		expect(() => runMigrations(db)).not.toThrow();
		expect(requestIndexNames(db)).toEqual(afterFirst);
		db.close();
	});
});

const FINAL_INDEXES = [
	"idx_requests_account_timestamp",
	"idx_requests_analytics_covering",
	"idx_requests_api_key_timestamp",
	"idx_requests_client_session",
	"idx_requests_err_ts_cov",
	"idx_requests_model_timestamp",
	"idx_requests_summary_covering",
];

describe("requests indexes: final set", () => {
	it("a fresh database has exactly the 7 approved indexes", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		expect(requestIndexNames(db)).toEqual(FINAL_INDEXES);
		db.close();
	});

	it("an upgraded database converges to the same 7 indexes, idempotently", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		for (const sql of OLD_INDEX_SQL) {
			db.run(sql);
		}
		runMigrations(db);
		runMigrations(db);
		expect(requestIndexNames(db)).toEqual(FINAL_INDEXES);
		db.close();
	});

	function seeded(): Database {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const ins = db.prepare(
			"INSERT INTO requests (id, timestamp, method, path, account_used, success, error_message, client_session_id) VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?)",
		);
		const now = Date.now();
		for (let i = 0; i < 3000; i++) {
			const isErr = i % 50 === 0;
			ins.run(
				`r${i}`,
				now - i * 1000,
				`acc${i % 3}`,
				isErr ? 0 : 1,
				isErr ? "rate_limited" : null,
				i % 10 === 0 ? `sess${i % 7}` : null,
			);
		}
		db.run("ANALYZE");
		return db;
	}

	function plan(db: Database, sql: string, params: unknown[]): string {
		return (
			db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
				detail: string;
			}[]
		)
			.map((r) => r.detail)
			.join("\n");
	}

	it("the session lookup uses idx_requests_client_session", () => {
		const db = seeded();
		const p = plan(
			db,
			`SELECT account_used FROM requests
			 WHERE client_session_id = ? AND account_used IS NOT NULL
			 ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
			["sess3"],
		);
		expect(p).toContain("idx_requests_client_session");
		db.close();
	});

	it("the error-group inner scan uses idx_requests_err_ts_cov", () => {
		const db = seeded();
		const p = plan(
			db,
			`SELECT r.error_message, COALESCE(r.account_used, ?) AS account_key, r.timestamp
			 FROM requests r
			 WHERE r.error_message IS NOT NULL AND r.error_message != '' AND r.timestamp > ?`,
			["no_account", Date.now() - 86_400_000],
		);
		expect(p).toContain("idx_requests_err_ts_cov");
		db.close();
	});
});
