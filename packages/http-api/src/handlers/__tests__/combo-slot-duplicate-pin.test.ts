import { describe, expect, it } from "bun:test";
import { createSlotAddHandler, createSlotUpdateHandler } from "../combos";

/**
 * combo_slots has UNIQUE(combo_id, account_id, model). Two slots for the same
 * account may differ only by their provider-routing suffix (`m {"only":["a"]}`
 * vs `m {"only":["b"]}`), which is intended; re-pinning a slot onto an
 * existing (combo, account, model) triple must not escape as a raw SQL
 * constraint error (HTTP 500). It is a client mistake → 409 with a readable
 * message, on both the add and the update route.
 */

type Slot = {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
};

const sqliteUnique = () =>
	Object.assign(new Error("UNIQUE constraint failed: combo_slots.combo_id"), {
		code: "SQLITE_CONSTRAINT_UNIQUE",
	});

// PostgreSQL (Bun.SQL) reports the same condition as SQLSTATE 23505.
const pgUnique = () =>
	Object.assign(new Error("duplicate key value violates unique constraint"), {
		code: "23505",
	});

function makeDbOps(thrown: unknown) {
	const added: unknown[] = [];
	const updated: unknown[] = [];
	return {
		added,
		updated,
		ops: {
			getCombo: async () => ({ id: "combo-1", name: "C", enabled: true }),
			getAccount: async (id: string) => ({
				id,
				name: "acc",
				provider: "anthropic",
			}),
			getComboSlots: async (): Promise<Slot[]> => [],
			addComboSlot: async () => {
				added.push(1);
				throw thrown;
			},
			updateComboSlot: async () => {
				updated.push(1);
				throw thrown;
			},
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: minimal DatabaseOperations mock
const asOps = (o: unknown) => o as any;

function postSlot(body: unknown) {
	return new Request("http://local/api/combos/combo-1/slots", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

function putSlot(body: unknown) {
	return new Request("http://local/api/combos/combo-1/slots/slot-1", {
		method: "PUT",
		body: JSON.stringify(body),
	});
}

describe("combo slot duplicate pin returns a clean client error", () => {
	it("returns 409 when adding a slot that duplicates (combo, account, model) — SQLite", async () => {
		const db = makeDbOps(sqliteUnique());
		const res = await createSlotAddHandler(asOps(db.ops))(
			postSlot({ account_id: "acc-1", model: 'm {"only":["a"]}' }),
			"combo-1",
		);

		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(String(body.error)).toContain("already exists");
		// No SQL text leaks to the client.
		expect(String(body.error)).not.toContain("UNIQUE constraint failed");
	});

	it("returns 409 when adding a duplicate — PostgreSQL", async () => {
		const db = makeDbOps(pgUnique());
		const res = await createSlotAddHandler(asOps(db.ops))(
			postSlot({ account_id: "acc-1", model: "m" }),
			"combo-1",
		);

		expect(res.status).toBe(409);
	});

	it("returns 409 when re-pinning a slot onto an existing triple", async () => {
		const db = makeDbOps(sqliteUnique());
		const res = await createSlotUpdateHandler(asOps(db.ops))(
			putSlot({ model: 'm {"only":["a"]}' }),
			"combo-1",
			"slot-1",
		);

		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(String(body.error)).toContain("already exists");
	});

	it("still returns 500 for an unrelated write failure", async () => {
		const db = makeDbOps(new Error("disk I/O error"));
		const res = await createSlotAddHandler(asOps(db.ops))(
			postSlot({ account_id: "acc-1", model: "m" }),
			"combo-1",
		);

		expect(res.status).toBe(500);
	});
});
