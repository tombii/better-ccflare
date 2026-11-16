import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "./migrations";
import { RequestRepository } from "./repositories/request.repository";

describe("requested model budget attribution", () => {
	let db: Database;
	let repository: RequestRepository;
	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repository = new RequestRepository(new BunSqlAdapter(db));
	});
	afterEach(() => db.close());

	it("keeps an opus budget attributable after a combo serves a GPT model and a later save omits metadata", async () => {
		const request = {
			id: "combo-budget",
			timestamp: Date.UTC(2026, 10, 13),
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 50,
			failoverAttempts: 0,
			apiKeyId: "key",
			usage: { model: "gpt-sol", costUsd: 2 },
		};
		await repository.save({ ...request, limitModel: "claude-opus-4-6" });
		await repository.save(request);
		const stored = db
			.query(
				"SELECT model, original_model, limit_model, cost_usd FROM requests WHERE id = ?",
			)
			.get(request.id);
		expect(stored).toEqual({
			model: "gpt-sol",
			original_model: null,
			limit_model: "claude-opus-4-6",
			cost_usd: 2,
		});
		const budget = db
			.query(
				"SELECT COALESCE(limit_model, original_model, model) AS scope_model FROM requests WHERE api_key_id = ?",
			)
			.get("key");
		expect(budget).toEqual({ scope_model: "claude-opus-4-6" });
	});
});
