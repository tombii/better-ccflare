import { describe, expect, it } from "bun:test";
import { createSlotAddHandler, createSlotUpdateHandler } from "../combos";

/**
 * Passthrough (a combo slot with an empty model) forwards the model the CLIENT
 * asked for. That only works where the upstream accepts Claude model ids —
 * Anthropic accounts. On a codex account the Claude name falls through to the
 * provider's built-in default map, which is the path that produced
 * `400 The 'gpt-5.3-codex' model is not supported when using Codex with a
 * ChatGPT account`.
 */

type Slot = {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
};

function makeDbOps(provider: string, slots: Slot[] = []) {
	const added: Array<{ accountId: string; model: string }> = [];
	const updated: Array<Record<string, unknown>> = [];
	return {
		added,
		updated,
		ops: {
			getCombo: async () => ({ id: "combo-1", name: "C", enabled: true }),
			getAccount: async (id: string) => ({ id, name: "acc", provider }),
			getComboSlots: async () => slots,
			addComboSlot: async (
				_comboId: string,
				accountId: string,
				model: string,
			) => {
				added.push({ accountId, model });
				return { id: "slot-new", model };
			},
			updateComboSlot: async (_id: string, fields: Record<string, unknown>) => {
				updated.push(fields);
				return { id: "slot-1", ...fields };
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

describe("combo slot: model required depending on the provider", () => {
	it("accepts a slot with no model on an anthropic account (passthrough)", async () => {
		const db = makeDbOps("anthropic");
		const res = await createSlotAddHandler(asOps(db.ops))(
			postSlot({ account_id: "acc-1" }),
			"combo-1",
		);

		expect(res.status).toBe(201);
		expect(db.added).toEqual([{ accountId: "acc-1", model: "" }]);
	});

	it("rejects a slot with no model on a codex account", async () => {
		const db = makeDbOps("codex");
		const res = await createSlotAddHandler(asOps(db.ops))(
			postSlot({ account_id: "acc-1" }),
			"combo-1",
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(String(body.error)).toContain("codex");
		// Nothing was written: the refusal happens before the insert.
		expect(db.added).toHaveLength(0);
	});

	it("accepts a slot WITH a model on a codex account", async () => {
		const db = makeDbOps("codex");
		const res = await createSlotAddHandler(asOps(db.ops))(
			postSlot({ account_id: "acc-1", model: "gpt-5.6-sol" }),
			"combo-1",
		);

		expect(res.status).toBe(201);
		expect(db.added).toEqual([{ accountId: "acc-1", model: "gpt-5.6-sol" }]);
	});

	// Without the same rule on the update route the validation is bypassable in
	// two steps: create the slot with a model, then empty it.
	it("rejects emptying the model of an existing codex slot", async () => {
		const slots: Slot[] = [
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "gpt-5.6-sol",
				priority: 0,
				enabled: true,
			},
		];
		const db = makeDbOps("codex", slots);
		const res = await createSlotUpdateHandler(asOps(db.ops))(
			new Request("http://local/api/combos/combo-1/slots/slot-1", {
				method: "PUT",
				body: JSON.stringify({ model: "" }),
			}),
			"combo-1",
			"slot-1",
		);

		expect(res.status).toBe(400);
		expect(db.updated).toHaveLength(0);
	});

	// Regression for the cross-combo bypass: updateComboSlot resolves the slot
	// globally, so a slot id addressed through a combo that does not own it used
	// to skip the provider check entirely and still be updated.
	it("rejects emptying a slot addressed through a combo that does not own it", async () => {
		// The combo in the path owns no slots, so the lookup finds nothing.
		const db = makeDbOps("codex", []);
		const res = await createSlotUpdateHandler(asOps(db.ops))(
			new Request("http://local/api/combos/other-combo/slots/slot-1", {
				method: "PUT",
				body: JSON.stringify({ model: "" }),
			}),
			"other-combo",
			"slot-1",
		);

		expect(res.status).toBe(404);
		expect(db.updated).toHaveLength(0);
	});

	it("allows emptying the model of an anthropic slot", async () => {
		const slots: Slot[] = [
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-opus-5",
				priority: 0,
				enabled: true,
			},
		];
		const db = makeDbOps("anthropic", slots);
		const res = await createSlotUpdateHandler(asOps(db.ops))(
			new Request("http://local/api/combos/combo-1/slots/slot-1", {
				method: "PUT",
				body: JSON.stringify({ model: "" }),
			}),
			"combo-1",
			"slot-1",
		);

		expect(res.status).toBe(200);
		expect(db.updated).toEqual([{ model: "" }]);
	});
});
