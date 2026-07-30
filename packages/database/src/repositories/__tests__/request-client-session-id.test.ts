/**
 * Tests for persistence of `client_session_id` on the requests table.
 *
 * Why the column exists: the proxy already reads the client session id from the
 * request body (`metadata.user_id`) and uses it for session-affinity routing,
 * but never stored it. Stored rows therefore carried no way to tell which
 * client session produced them — a session's own requests and those of its
 * subagents are indistinguishable after the fact, since they share account,
 * model and time window. That gap has produced real misattribution.
 *
 * Covers:
 *  - save() persists the id and reads it back.
 *  - UPSERT is PRESERVE-FIRST: a later save() that carries no session id (the
 *    error paths re-save rows without one) must not blank out what the main
 *    path recorded.
 *  - A later save() that does carry an id still updates it.
 *  - runMigrations() adds the column to a database created before it existed.
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

function baseRequestData(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 100,
		failoverAttempts: 0,
		...overrides,
	};
}

function readSessionId(db: Database, id: string): string | null {
	const row = db
		.query("SELECT client_session_id FROM requests WHERE id = ?")
		.get(id) as { client_session_id: string | null } | null;
	return row?.client_session_id ?? null;
}

describe("RequestRepository — client session id persistence", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("saves and reads back the client session id", async () => {
		await repo.save(
			baseRequestData("req-1", { clientSessionId: "session-abc" }),
		);

		expect(readSessionId(db, "req-1")).toBe("session-abc");
	});

	it("stores null when the request carries no session id", async () => {
		await repo.save(baseRequestData("req-2"));

		expect(readSessionId(db, "req-2")).toBeNull();
	});

	it("preserves the stored id when a later save omits it", async () => {
		// The main path records the id; an error path re-saves the same row
		// without one. Overwriting here would destroy the attribution exactly
		// for the requests that are most interesting to trace.
		await repo.save(
			baseRequestData("req-3", { clientSessionId: "session-keep" }),
		);
		await repo.save(baseRequestData("req-3", { statusCode: 500 }));

		expect(readSessionId(db, "req-3")).toBe("session-keep");
	});

	it("updates the id when a later save does carry one", async () => {
		await repo.save(baseRequestData("req-4"));
		await repo.save(
			baseRequestData("req-4", { clientSessionId: "session-late" }),
		);

		expect(readSessionId(db, "req-4")).toBe("session-late");
	});

	it("does not disturb neighbouring columns on a re-save", async () => {
		await repo.save(
			baseRequestData("req-5", {
				clientSessionId: "session-xyz",
				project: "proj",
				projectAttributionSource: "header_project",
			}),
		);
		await repo.save(baseRequestData("req-5", { statusCode: 502 }));

		const row = db
			.query(
				"SELECT client_session_id, project, project_attribution_source, status_code FROM requests WHERE id = ?",
			)
			.get("req-5") as Record<string, unknown>;

		expect(row.client_session_id).toBe("session-xyz");
		expect(row.project).toBe("proj");
		expect(row.project_attribution_source).toBe("header_project");
		expect(row.status_code).toBe(502);
	});
});

describe("migrations — client_session_id", () => {
	it("adds the column to a database created before it existed", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		// Simulate the pre-column state of an existing installation.
		db.run("ALTER TABLE requests DROP COLUMN client_session_id");
		const before = db.query("PRAGMA table_info(requests)").all() as Array<{
			name: string;
		}>;
		expect(before.some((c) => c.name === "client_session_id")).toBe(false);

		runMigrations(db);

		const after = db.query("PRAGMA table_info(requests)").all() as Array<{
			name: string;
		}>;
		expect(after.some((c) => c.name === "client_session_id")).toBe(true);
		db.close();
	});
});
