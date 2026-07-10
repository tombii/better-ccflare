/**
 * Tests for RequestRepository.save persisting original_model/applied_model
 * (agent-preference model rewrite observability — issue C5b).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency. Same pattern as account-pause-reason.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

function makeRepo(): { db: Database; repo: RequestRepository } {
	const db = new Database(":memory:");
	// runMigrations calls ensureSchema internally, then applies the additive
	// ALTER TABLE migrations (api_key_id, combo_name, etc.) that save() relies on.
	runMigrations(db);
	const adapter = new BunSqlAdapter(db);
	return { db, repo: new RequestRepository(adapter) };
}

describe("RequestRepository.save - original_model/applied_model", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		({ db, repo } = makeRepo());
	});

	afterEach(() => {
		db.close();
	});

	it("persists both columns when a rewrite occurred", async () => {
		await repo.save({
			id: "req-rewrite-1",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			originalModel: "claude-3-5-sonnet-20241022",
			appliedModel: "claude-opus-model",
		});

		const row = db
			.prepare(
				"SELECT original_model, applied_model FROM requests WHERE id = ?",
			)
			.get("req-rewrite-1") as {
			original_model: string | null;
			applied_model: string | null;
		};

		expect(row.original_model).toBe("claude-3-5-sonnet-20241022");
		expect(row.applied_model).toBe("claude-opus-model");
	});

	it("leaves both columns NULL when no rewrite occurred (fields omitted)", async () => {
		await repo.save({
			id: "req-no-rewrite",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
		});

		const row = db
			.prepare(
				"SELECT original_model, applied_model FROM requests WHERE id = ?",
			)
			.get("req-no-rewrite") as {
			original_model: string | null;
			applied_model: string | null;
		};

		expect(row.original_model).toBeNull();
		expect(row.applied_model).toBeNull();
	});

	it("ON CONFLICT upsert preserves previously-set values via COALESCE when the second write omits them", async () => {
		await repo.save({
			id: "req-upsert",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			originalModel: "claude-3-5-sonnet-20241022",
			appliedModel: "claude-opus-model",
		});

		// Second write (e.g. a later usage update) omits the rewrite fields —
		// COALESCE(EXCLUDED.x, requests.x) must keep the original values.
		await repo.save({
			id: "req-upsert",
			method: "POST",
			path: "/v1/messages",
			accountUsed: "acc-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 150,
			failoverAttempts: 0,
		});

		const row = db
			.prepare(
				"SELECT original_model, applied_model, account_used FROM requests WHERE id = ?",
			)
			.get("req-upsert") as {
			original_model: string | null;
			applied_model: string | null;
			account_used: string | null;
		};

		expect(row.original_model).toBe("claude-3-5-sonnet-20241022");
		expect(row.applied_model).toBe("claude-opus-model");
		expect(row.account_used).toBe("acc-1");
	});
});
