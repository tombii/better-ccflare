/**
 * Tests for buildRequestFilters — the no-account drill-down.
 *
 * The dashboard's `accounts=no_account` filter used to bind to
 * `r.account_used = 'no_account'` (legacy literal only), which matched
 * nothing under the current NULL encoding. The query now also matches
 * `r.account_used IS NULL`, so the drill-down returns the unauthenticated
 * rows regardless of how they were originally encoded, without regressing
 * older deployments that still have literal 'no_account' rows.
 *
 * These tests run the generated clause against real SQLite to verify the
 * bind actually filters the right rows. We keep the schema minimal (just
 * the columns referenced by the clause plus a `timestamp` for the window
 * guard) to avoid pulling in the database package, whose index exports
 * inline-worker modules that are not always built (`bun run build:cli`).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import { buildRequestFilters } from "../query-filters";

function makeDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE requests (
			id TEXT PRIMARY KEY,
			timestamp INTEGER NOT NULL,
			account_used TEXT
		)
	`);
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL
		)
	`);
	return db;
}

function insertRequest(
	db: Database,
	row: { id: string; timestamp: number; account_used: string | null },
) {
	db.run(
		"INSERT INTO requests (id, timestamp, account_used) VALUES (?, ?, ?)",
		[row.id, row.timestamp, row.account_used],
	);
}

function insertAccount(db: Database, row: { id: string; name: string }) {
	db.run("INSERT INTO accounts (id, name) VALUES (?, ?)", [row.id, row.name]);
}

describe("buildRequestFilters — no-account drill-down binding", () => {
	let db: Database;

	beforeEach(() => {
		db = makeDb();
	});

	afterEach(() => {
		db.close();
	});

	it("returns rows with NULL account_used when filter is accounts=no_account", () => {
		insertRequest(db, { id: "n1", timestamp: 1000, account_used: null });
		insertRequest(db, { id: "n2", timestamp: 2000, account_used: null });

		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams(`accounts=${NO_ACCOUNT_ID}`),
			0,
		);

		const rows = db
			.query<{ id: string }, (string | number)[]>(
				`SELECT id FROM requests r WHERE ${whereClause} ORDER BY id`,
			)
			.all(...params);

		expect(rows.map((r) => r.id).sort()).toEqual(["n1", "n2"]);
	});

	it("returns legacy literal 'no_account' rows when filter is accounts=no_account", () => {
		insertRequest(db, {
			id: "l1",
			timestamp: 1000,
			account_used: NO_ACCOUNT_ID,
		});
		insertRequest(db, {
			id: "l2",
			timestamp: 2000,
			account_used: NO_ACCOUNT_ID,
		});

		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams(`accounts=${NO_ACCOUNT_ID}`),
			0,
		);

		const rows = db
			.query<{ id: string }, (string | number)[]>(
				`SELECT id FROM requests r WHERE ${whereClause} ORDER BY id`,
			)
			.all(...params);

		expect(rows.map((r) => r.id).sort()).toEqual(["l1", "l2"]);
	});

	it("returns both NULL and legacy rows when both encodings are present", () => {
		insertRequest(db, { id: "n1", timestamp: 1000, account_used: null });
		insertRequest(db, { id: "n2", timestamp: 2000, account_used: null });
		insertRequest(db, {
			id: "l1",
			timestamp: 3000,
			account_used: NO_ACCOUNT_ID,
		});

		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams(`accounts=${NO_ACCOUNT_ID}`),
			0,
		);

		const rows = db
			.query<{ id: string }, (string | number)[]>(
				`SELECT id FROM requests r WHERE ${whereClause} ORDER BY id`,
			)
			.all(...params);

		expect(rows.map((r) => r.id).sort()).toEqual(["l1", "n1", "n2"]);
	});

	it("does not match no-account rows when filter is accounts=acct-real", () => {
		insertAccount(db, { id: "real-1", name: "acct-real" });
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			account_used: "real-1",
		});
		insertRequest(db, { id: "n1", timestamp: 2000, account_used: null });
		insertRequest(db, {
			id: "l1",
			timestamp: 3000,
			account_used: NO_ACCOUNT_ID,
		});

		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("accounts=acct-real"),
			0,
		);

		const rows = db
			.query<{ id: string }, (string | number)[]>(
				`SELECT id FROM requests r WHERE ${whereClause} ORDER BY id`,
			)
			.all(...params);

		expect(rows.map((r) => r.id)).toEqual(["r1"]);
	});

	it("matches both the named account and no-account rows when filter includes both", () => {
		insertAccount(db, { id: "real-1", name: "acct-real" });
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			account_used: "real-1",
		});
		insertRequest(db, { id: "n1", timestamp: 2000, account_used: null });
		insertRequest(db, {
			id: "l1",
			timestamp: 3000,
			account_used: NO_ACCOUNT_ID,
		});

		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams(`accounts=acct-real,${NO_ACCOUNT_ID}`),
			0,
		);

		const rows = db
			.query<{ id: string }, (string | number)[]>(
				`SELECT id FROM requests r WHERE ${whereClause} ORDER BY id`,
			)
			.all(...params);

		expect(rows.map((r) => r.id).sort()).toEqual(["l1", "n1", "r1"]);
	});
});
