/**
 * Tests for RequestRepository.updateComboTags: request history is tagged with
 * the combo NAME, so renaming a combo must re-point existing rows or the Combo
 * Flow view loses the combo's 24h totals.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types
// resolves its circular dependency (same pattern as request-model-rewrite).
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

function makeRepo(): { db: Database; repo: RequestRepository } {
	const db = new Database(":memory:");
	runMigrations(db);
	return { db, repo: new RequestRepository(new BunSqlAdapter(db)) };
}

describe("RequestRepository.updateComboTags", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		({ db, repo } = makeRepo());
	});

	afterEach(() => {
		db.close();
	});

	const saveRow = (id: string, comboName: string | null) =>
		repo.save({
			id,
			method: "POST",
			path: "/v1/messages",
			accountUsed: "acc-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 100,
			failoverAttempts: 0,
			comboName,
		});

	const tags = () =>
		Object.fromEntries(
			(
				db
					.prepare("SELECT id, combo_name FROM requests ORDER BY id")
					.all() as Array<{ id: string; combo_name: string | null }>
			).map((row) => [row.id, row.combo_name]),
		);

	it("re-points only the renamed combo's rows and returns the count", async () => {
		await saveRow("r1", "Main");
		await saveRow("r2", "Main");
		await saveRow("r3", "Other");
		await saveRow("r4", null);

		const migrated = await repo.updateComboTags("Main", "Main v2");

		expect(migrated).toBe(2);
		expect(tags()).toEqual({
			r1: "Main v2",
			r2: "Main v2",
			r3: "Other",
			r4: null,
		});
	});

	it("is a no-op with a zero count when no rows carry the old name", async () => {
		await saveRow("r1", "Main");

		const migrated = await repo.updateComboTags("Ghost", "Ghost v2");

		expect(migrated).toBe(0);
		expect(tags()).toEqual({ r1: "Main" });
	});
});
