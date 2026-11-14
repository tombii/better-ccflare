import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ApiKeyRepository } from "../api-key.repository";
import { ComboRepository } from "../combo.repository";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases) db.close();
	databases.length = 0;
});
function setup() {
	const db = new Database(":memory:");
	databases.push(db);
	ensureSchema(db);
	runMigrations(db);
	const adapter = new BunSqlAdapter(db);
	return { db, adapter, keys: new ApiKeyRepository(adapter) };
}
const key = {
	id: "k",
	name: "k",
	hashed_key: "hash",
	prefix_last_8: "last8",
	created_at: 1,
	last_used: null,
	is_active: 1,
	role: "api-only" as const,
	allowed_accounts: null,
	allowed_models: null,
	allowed_providers: null,
	limit_usd: 5,
	limit_window: "rolling_7d" as const,
	limit_enforce: "block" as const,
};

describe("API key review atomicity regressions", () => {
	it("rolls back a new key if its enforceable limit cannot be inserted", async () => {
		const { db, keys } = setup();
		db.run(
			"CREATE TRIGGER fail_limit BEFORE INSERT ON api_key_limits BEGIN SELECT RAISE(ABORT, 'limit failed'); END",
		);
		await expect(keys.create(key)).rejects.toThrow("limit failed");
		expect(await keys.findById("k")).toBeNull();
	});
	it("creates legacy metadata and its rolling limit together", async () => {
		const { keys } = setup();
		await keys.create(key);
		expect((await keys.findById("k"))?.limitWindowMode).toBe("rolling");
		expect(await keys.getLimits("k")).toMatchObject([
			{ window: "week", limitUsd: 5, enforce: "block" },
		]);
	});
	it("returns false for an older or missing reset and preserves alert cooldowns", async () => {
		const { db, keys } = setup();
		await keys.create(key);
		expect(await keys.resetSpend("k", 200, "new")).toBe(true);
		db.run(
			"INSERT INTO alerts (id,type,severity,title,message,timestamp) VALUES ('api_key_spend_limit:k:hour','api_key_spend_limit','warning','limit','limit',1)",
		);
		expect(await keys.resetSpend("k", 100, "old")).toBe(false);
		expect(await keys.resetSpend("missing", 300, "none")).toBe(false);
		expect(db.query("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({
			n: 1,
		});
		expect((await keys.findById("k"))?.spendResetBy).toBe("new");
		expect(await keys.resetSpend("k", 300, "newer")).toBe(true);
		expect(db.query("SELECT COUNT(*) AS n FROM alerts").get()).toEqual({
			n: 0,
		});
	});
	it("cleans the current routing value inside the combo deletion transaction", async () => {
		const { db, adapter, keys } = setup();
		await keys.create(key);
		db.run(
			"INSERT INTO combos (id,name,created_at,updated_at) VALUES ('gone','gone',1,1)",
		);
		db.run("UPDATE api_keys SET family_combo_overrides = ? WHERE id = 'k'", [
			JSON.stringify({ opus: "gone" }),
		]);
		const atomic = adapter.atomicStatements.bind(adapter);
		adapter.atomicStatements = async (statements) => {
			// A routing edit lands after delete() begins but before its batch executes.
			db.run("UPDATE api_keys SET family_combo_overrides = ? WHERE id = 'k'", [
				JSON.stringify({ opus: "gone", sonnet: "kept" }),
			]);
			return atomic(statements);
		};
		await new ComboRepository(adapter).delete("gone");
		expect((await keys.findById("k"))?.familyComboOverrides).toEqual({
			sonnet: "kept",
		});
	});
	it("runs PostgreSQL key and limit inserts in one parameterized batch", async () => {
		const batches: Array<Array<{ sql: string; params: unknown[] }>> = [];
		const client = {
			begin: async (
				fn: (tx: {
					unsafe: (
						sql: string,
						params: unknown[],
					) => Promise<{ count: number }>;
				}) => Promise<unknown>,
			) => {
				const batch: Array<{ sql: string; params: unknown[] }> = [];
				batches.push(batch);
				return fn({
					unsafe: async (sql, params) => {
						batch.push({ sql, params });
						return { count: 1 };
					},
				});
			},
		} as unknown as SQL;
		const adapter = new BunSqlAdapter(client, false);
		await new ApiKeyRepository(adapter).create(key);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(2);
		expect(batches[0][0].sql).toContain("INSERT INTO api_keys");
		expect(batches[0][1].sql).toContain("INSERT INTO api_key_limits");
		expect(batches[0][1].sql).toContain("$1");
		expect(
			await adapter.atomicStatements([
				{ sql: "UPDATE api_keys SET name = ?", params: ["n"] },
			]),
		).toEqual([1]);
	});
	it("nulls an emptied routing map and rolls cleanup back if combo deletion fails", async () => {
		const { db, adapter, keys } = setup();
		await keys.create(key);
		db.run(
			"INSERT INTO combos (id,name,created_at,updated_at) VALUES ('gone','gone',1,1)",
		);
		db.run("UPDATE api_keys SET family_combo_overrides = ? WHERE id = 'k'", [
			JSON.stringify({ opus: "gone" }),
		]);
		db.run(
			"CREATE TRIGGER fail_combo BEFORE DELETE ON combos BEGIN SELECT RAISE(ABORT, 'delete failed'); END",
		);
		await expect(new ComboRepository(adapter).delete("gone")).rejects.toThrow(
			"delete failed",
		);
		expect((await keys.findById("k"))?.familyComboOverrides).toEqual({
			opus: "gone",
		});
		db.run("DROP TRIGGER fail_combo");
		await new ComboRepository(adapter).delete("gone");
		expect((await keys.findById("k"))?.familyComboOverrides).toBeNull();
	});
	it("uses PostgreSQL transaction counts for stale resets and server-side JSON cleanup", async () => {
		const statements: string[] = [];
		const client = {
			begin: async (
				fn: (tx: {
					unsafe: (sql: string) => Promise<{ count: number }>;
				}) => Promise<unknown>,
			) =>
				fn({
					unsafe: async (sql) => {
						statements.push(sql);
						return { count: 0 };
					},
				}),
		} as unknown as SQL;
		const adapter = new BunSqlAdapter(client, false);
		expect(
			await new ApiKeyRepository(adapter).resetSpend("k", 100, "old"),
		).toBe(false);
		expect(statements).toHaveLength(2);
		expect(statements[1]).toContain(
			"spend_reset_at = $4 AND spend_reset_by = $5",
		);
		statements.length = 0;
		await new ComboRepository(adapter).delete("gone");
		expect(statements).toHaveLength(2);
		expect(statements[0]).toContain(
			"jsonb_each_text(api_keys.family_combo_overrides::jsonb)",
		);
		expect(statements[0]).toContain("value <> $1");
		expect(statements[1]).toBe("DELETE FROM combos WHERE id = $1");
	});
});
