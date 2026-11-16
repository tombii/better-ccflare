import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "./migrations";
import { RequestRepository } from "./repositories/request.repository";

let db: Database;
let repository: RequestRepository;
beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	repository = new RequestRepository(new BunSqlAdapter(db));
});
afterEach(() => db.close());

it("preserves the logical cost-recording time when an older save omits it", async () => {
	const request = {
		id: "request",
		timestamp: 1_000,
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 100,
		failoverAttempts: 0,
		usage: { costUsd: 2 },
	};
	await repository.save({ ...request, spendRecordedAt: 2_000 });
	await repository.save(request);
	expect(
		db
			.query(
				"SELECT timestamp,response_time_ms,spend_recorded_at,cost_usd FROM requests",
			)
			.get(),
	).toEqual({
		timestamp: 1_000,
		response_time_ms: 100,
		spend_recorded_at: 2_000,
		cost_usd: 2,
	});
});
