import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { RequestRepository } from "../request.repository";

function makeLegacyObservabilityDb(): Database {
	const db = new Database(":memory:");
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
			failover_attempts INTEGER DEFAULT 0,
			model TEXT,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cost_usd REAL DEFAULT 0,
			input_tokens INTEGER DEFAULT 0,
			cache_read_input_tokens INTEGER DEFAULT 0,
			cache_creation_input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			agent_used TEXT,
			output_tokens_per_second REAL,
			api_key_id TEXT,
			api_key_name TEXT,
			project TEXT,
			billing_type TEXT DEFAULT 'api',
			combo_name TEXT,
			upstream_path TEXT NOT NULL,
			routing_mode TEXT NOT NULL
		)
	`);
	return db;
}

describe("RequestRepository.save legacy observability columns", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeLegacyObservabilityDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("persists compatibility requests when legacy DB has NOT NULL upstream_path/routing_mode", async () => {
		await repo.save({
			id: "req-legacy-observability",
			method: "POST",
			path: "/v1/messages",
			accountUsed: "acct-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 123,
			failoverAttempts: 0,
		});

		const row = db
			.query<{ upstream_path: string; routing_mode: string }, []>(
				"SELECT upstream_path, routing_mode FROM requests WHERE id = 'req-legacy-observability'",
			)
			.get();

		expect(row).toEqual({
			upstream_path: "/v1/messages",
			routing_mode: "compatibility",
		});
	});
});
