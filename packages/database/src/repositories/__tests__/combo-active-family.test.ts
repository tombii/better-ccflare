import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ComboRepository } from "../combo.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function makeRepo(db: Database): ComboRepository {
	return new ComboRepository(new BunSqlAdapter(db));
}

/** Adapter that records every statement it is asked to run. */
class CountingAdapter extends BunSqlAdapter {
	statements: string[] = [];

	override async query<R>(
		sqlStr: string,
		params: unknown[] = [],
	): Promise<R[]> {
		this.statements.push(sqlStr);
		return super.query<R>(sqlStr, params);
	}

	override async get<R>(
		sqlStr: string,
		params: unknown[] = [],
	): Promise<R | null> {
		this.statements.push(sqlStr);
		return super.get<R>(sqlStr, params);
	}
}

const NOW = 1_700_000_000_000;

function insertCombo(
	db: Database,
	id: string,
	name: string,
	enabled: number,
): Promise<void> {
	db.run(
		`INSERT INTO combos (id, name, description, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[id, name, `desc-${name}`, enabled, NOW, NOW],
	);
}

function insertSlot(
	db: Database,
	id: string,
	comboId: string,
	accountId: string,
	model: string,
	priority: number,
	enabled: number,
): Promise<void> {
	db.run(
		`INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[id, comboId, accountId, model, priority, enabled],
	);
}

function assignFamily(
	db: Database,
	family: string,
	comboId: string | null,
	enabled: number,
): Promise<void> {
	db.run(
		`INSERT INTO combo_family_assignments (family, combo_id, enabled)
     VALUES (?, ?, ?)
     ON CONFLICT(family) DO UPDATE SET combo_id = excluded.combo_id, enabled = excluded.enabled`,
		[family, comboId, enabled],
	);
}

describe("ComboRepository.getActiveComboForFamily", () => {
	it("returns null when no assignment exists for the family", async () => {
		const db = makeDb();
		const repo = makeRepo(db);

		expect(await repo.getActiveComboForFamily("sonnet")).toBeNull();

		db.close();
	});

	it("returns null when the family assignment is disabled or has no combo", async () => {
		const db = makeDb();
		const repo = makeRepo(db);

		insertCombo(db, "combo-1", "combo-one", 1);
		assignFamily(db, "sonnet", "combo-1", 0);

		expect(await repo.getActiveComboForFamily("sonnet")).toBeNull();

		// Assignment present and enabled, but the combo was unassigned
		// (combo_id IS NULL) — the "no active combo" contract.
		assignFamily(db, "opus", null, 1);
		expect(await repo.getActiveComboForFamily("opus")).toBeNull();

		db.close();
	});

	it("returns null when the assigned combo is disabled", async () => {
		const db = makeDb();
		const repo = makeRepo(db);

		insertCombo(db, "combo-1", "combo-one", 0);
		assignFamily(db, "sonnet", "combo-1", 1);

		expect(await repo.getActiveComboForFamily("sonnet")).toBeNull();

		db.close();
	});

	it("returns the combo with an empty slot array when it has no enabled slots", async () => {
		const db = makeDb();
		const repo = makeRepo(db);

		insertCombo(db, "combo-1", "combo-one", 1);
		assignFamily(db, "sonnet", "combo-1", 1);

		// No slots at all.
		const noSlots = await repo.getActiveComboForFamily("sonnet");
		expect(noSlots).toEqual({
			id: "combo-1",
			name: "combo-one",
			description: "desc-combo-one",
			enabled: true,
			created_at: NOW,
			updated_at: NOW,
			slots: [],
		});

		// Slots exist but are all disabled.
		insertSlot(db, "slot-1", "combo-1", "acct-1", "m1", 0, 0);
		const disabledSlots = await repo.getActiveComboForFamily("sonnet");
		expect(disabledSlots).toEqual({
			id: "combo-1",
			name: "combo-one",
			description: "desc-combo-one",
			enabled: true,
			created_at: NOW,
			updated_at: NOW,
			slots: [],
		});

		db.close();
	});

	it("returns enabled slots ordered by priority ascending", async () => {
		const db = makeDb();
		const repo = makeRepo(db);

		insertCombo(db, "combo-1", "combo-one", 1);
		assignFamily(db, "sonnet", "combo-1", 1);

		// Inserted out of order; a disabled slot must be excluded entirely.
		insertSlot(db, "slot-c", "combo-1", "acct-c", "m-c", 20, 1);
		insertSlot(db, "slot-b", "combo-1", "acct-b", "m-b", 10, 1);
		insertSlot(db, "slot-a", "combo-1", "acct-a", "m-a", 5, 1);
		insertSlot(db, "slot-d", "combo-1", "acct-d", "m-d", 30, 0);

		const combo = await repo.getActiveComboForFamily("sonnet");
		expect(combo).not.toBeNull();
		expect(combo?.slots.map((s) => s.id)).toEqual([
			"slot-a",
			"slot-b",
			"slot-c",
		]);
		expect(combo?.slots.map((s) => s.priority)).toEqual([5, 10, 20]);
		expect(combo?.slots.map((s) => s.account_id)).toEqual([
			"acct-a",
			"acct-b",
			"acct-c",
		]);
		expect(combo?.slots.map((s) => s.model)).toEqual(["m-a", "m-b", "m-c"]);
		expect(combo?.slots.every((s) => s.enabled)).toBe(true);
		expect(combo?.slots.every((s) => s.combo_id === "combo-1")).toBe(true);

		// Full shape, including key order (byte-identical contract).
		expect(Object.keys(combo as object)).toEqual([
			"id",
			"name",
			"description",
			"enabled",
			"created_at",
			"updated_at",
			"slots",
		]);
		expect(Object.keys(combo?.slots[0] as object)).toEqual([
			"id",
			"combo_id",
			"account_id",
			"model",
			"priority",
			"enabled",
		]);

		db.close();
	});

	it("issues exactly one database statement per call", async () => {
		const db = makeDb();
		const adapter = new CountingAdapter(db);
		const repo = new ComboRepository(adapter);

		await insertCombo(db, "combo-1", "combo-one", 1);
		await assignFamily(db, "sonnet", "combo-1", 1);
		await insertSlot(db, "slot-a", "combo-1", "acct-a", "m-a", 5, 1);
		await insertSlot(db, "slot-b", "combo-1", "acct-b", "m-b", 10, 1);

		adapter.statements.length = 0;
		const combo = await repo.getActiveComboForFamily("sonnet");
		expect(combo?.slots).toHaveLength(2);
		expect(adapter.statements).toHaveLength(1);

		// A miss is also a single statement.
		adapter.statements.length = 0;
		expect(await repo.getActiveComboForFamily("haiku")).toBeNull();
		expect(adapter.statements).toHaveLength(1);

		db.close();
	});
});
