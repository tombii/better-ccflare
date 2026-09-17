/**
 * Tests for persistence of the `gateway_hint_*` columns on the requests
 * table.
 *
 * Why the columns exist: Claude Code CLI >= 2.1.273 can opt in (client-side
 * `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`) to sending five request headers —
 * x-claude-code-request-class, x-claude-code-agent-type,
 * x-claude-code-prev-tool-durations, x-claude-code-compaction, and
 * x-claude-code-context-compacted — that better-ccflare previously discarded
 * entirely. They are pure observability metadata, so persistence follows the
 * exact same preserve-first UPSERT shape already established for
 * `client_session_id` (see request-client-session-id.test.ts).
 *
 * Covers:
 *  - save() persists all five values and reads them back.
 *  - save() with none of the five leaves all five columns NULL (backward
 *    compatibility: the overwhelming majority of requests carry none).
 *  - UPSERT is PRESERVE-FIRST: a later save() that carries no gateway-hint
 *    values (the error paths re-save rows without them) must not blank out
 *    what the main path recorded.
 *  - A later save() that does carry values still updates them.
 *  - A re-save does not disturb neighbouring columns (client_session_id,
 *    project, ...).
 *  - runMigrations() adds the columns to a database created before they
 *    existed.
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

interface GatewayHintRow {
	gateway_hint_request_class: string | null;
	gateway_hint_agent_type: string | null;
	gateway_hint_prev_tool_durations: string | null;
	gateway_hint_compaction: string | null;
	gateway_hint_context_compacted: string | null;
}

function readGatewayHint(db: Database, id: string): GatewayHintRow | null {
	return (
		(db
			.query(
				`SELECT gateway_hint_request_class, gateway_hint_agent_type,
					gateway_hint_prev_tool_durations, gateway_hint_compaction,
					gateway_hint_context_compacted
				 FROM requests WHERE id = ?`,
			)
			.get(id) as GatewayHintRow | null) ?? null
	);
}

describe("RequestRepository — gateway hint header persistence", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("saves and reads back all five gateway hint values", async () => {
		await repo.save(
			baseRequestData("req-1", {
				gatewayHintRequestClass: "primary",
				gatewayHintAgentType: "general-purpose",
				gatewayHintPrevToolDurations: "[120,340]",
				gatewayHintCompaction: "auto",
				gatewayHintContextCompacted: "true",
			}),
		);

		expect(readGatewayHint(db, "req-1")).toEqual({
			gateway_hint_request_class: "primary",
			gateway_hint_agent_type: "general-purpose",
			gateway_hint_prev_tool_durations: "[120,340]",
			gateway_hint_compaction: "auto",
			gateway_hint_context_compacted: "true",
		});
	});

	it("stores all five columns as NULL when the request carries none of the headers", async () => {
		await repo.save(baseRequestData("req-2"));

		expect(readGatewayHint(db, "req-2")).toEqual({
			gateway_hint_request_class: null,
			gateway_hint_agent_type: null,
			gateway_hint_prev_tool_durations: null,
			gateway_hint_compaction: null,
			gateway_hint_context_compacted: null,
		});
	});

	it("persists a single present value while the rest stay NULL", async () => {
		await repo.save(
			baseRequestData("req-single", {
				gatewayHintAgentType: "subagent",
			}),
		);

		const row = readGatewayHint(db, "req-single");
		expect(row?.gateway_hint_agent_type).toBe("subagent");
		expect(row?.gateway_hint_request_class).toBeNull();
		expect(row?.gateway_hint_prev_tool_durations).toBeNull();
		expect(row?.gateway_hint_compaction).toBeNull();
		expect(row?.gateway_hint_context_compacted).toBeNull();
	});

	it("preserves stored values when a later save omits them", async () => {
		// The main path records the values; an error path re-saves the same
		// row without them. Overwriting here would erase attribution that is
		// most useful exactly for the requests that hit an error path.
		await repo.save(
			baseRequestData("req-3", {
				gatewayHintRequestClass: "primary",
				gatewayHintCompaction: "auto",
			}),
		);
		await repo.save(baseRequestData("req-3", { statusCode: 500 }));

		const row = readGatewayHint(db, "req-3");
		expect(row?.gateway_hint_request_class).toBe("primary");
		expect(row?.gateway_hint_compaction).toBe("auto");
	});

	it("updates the values when a later save does carry new ones", async () => {
		await repo.save(baseRequestData("req-4"));
		await repo.save(
			baseRequestData("req-4", {
				gatewayHintRequestClass: "background",
				gatewayHintContextCompacted: "true",
			}),
		);

		const row = readGatewayHint(db, "req-4");
		expect(row?.gateway_hint_request_class).toBe("background");
		expect(row?.gateway_hint_context_compacted).toBe("true");
	});

	it("does not disturb neighbouring columns on a re-save", async () => {
		await repo.save(
			baseRequestData("req-5", {
				gatewayHintRequestClass: "primary",
				clientSessionId: "session-xyz",
				project: "proj",
				projectAttributionSource: "header_project",
			}),
		);
		await repo.save(baseRequestData("req-5", { statusCode: 502 }));

		const row = db
			.query(
				`SELECT gateway_hint_request_class, client_session_id, project,
					project_attribution_source, status_code
				 FROM requests WHERE id = ?`,
			)
			.get("req-5") as Record<string, unknown>;

		expect(row.gateway_hint_request_class).toBe("primary");
		expect(row.client_session_id).toBe("session-xyz");
		expect(row.project).toBe("proj");
		expect(row.project_attribution_source).toBe("header_project");
		expect(row.status_code).toBe(502);
	});
});

describe("migrations — gateway_hint_* columns", () => {
	it("adds the columns to a database created before they existed", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		const columns = [
			"gateway_hint_request_class",
			"gateway_hint_agent_type",
			"gateway_hint_prev_tool_durations",
			"gateway_hint_compaction",
			"gateway_hint_context_compacted",
		];
		// Simulate the pre-column state of an existing installation.
		for (const col of columns) {
			db.run(`ALTER TABLE requests DROP COLUMN ${col}`);
		}
		const before = db.query("PRAGMA table_info(requests)").all() as Array<{
			name: string;
		}>;
		for (const col of columns) {
			expect(before.some((c) => c.name === col)).toBe(false);
		}

		runMigrations(db);

		const after = db.query("PRAGMA table_info(requests)").all() as Array<{
			name: string;
		}>;
		for (const col of columns) {
			expect(after.some((c) => c.name === col)).toBe(true);
		}
		db.close();
	});
});
