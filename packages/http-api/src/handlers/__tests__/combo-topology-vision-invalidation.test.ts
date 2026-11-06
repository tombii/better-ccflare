import { afterEach, describe, expect, it } from "bun:test";
import {
	clearVisionCapability,
	isVisionUnsupported,
	markVisionUnsupported,
} from "@better-ccflare/proxy";
import {
	createComboDeleteHandler,
	createComboUpdateHandler,
	createSlotAddHandler,
	createSlotRemoveHandler,
} from "../combos";

/**
 * Learned image refusals are cached per (account, model) pair, and a combo slot
 * is how an operator pins that pair. Adding a pin, removing one, or deleting the
 * combo that held it all change which upstream answers an image request, so an
 * entry learned under the previous topology must not keep skipping the route.
 *
 * The flip side matters just as much: a change that routes nothing new — a
 * rename, a description edit, a re-save that enables an already-enabled combo,
 * a passthrough slot with no pin — must leave the cache alone, or every trivial
 * edit costs a re-learn round-trip per blind pair.
 */

type Slot = {
	id: string;
	combo_id: string;
	account_id: string;
	model: string;
	priority: number;
	enabled: boolean;
};

function makeDbOps(
	opts: { enabled?: boolean; slots?: Slot[]; provider?: string } = {},
) {
	const deleted: string[] = [];
	const removed: string[] = [];
	const added: Array<{ accountId: string; model: string }> = [];
	return {
		deleted,
		removed,
		added,
		ops: {
			getCombo: async () => ({
				id: "combo-1",
				name: "C",
				description: null,
				enabled: opts.enabled ?? true,
			}),
			getAccount: async (id: string) => ({
				id,
				name: "acc",
				provider: opts.provider ?? "codex",
			}),
			getComboSlots: async () => opts.slots ?? [],
			addComboSlot: async (_c: string, accountId: string, model: string) => {
				added.push({ accountId, model });
				return { id: "slot-new", model };
			},
			updateCombo: async (_id: string, fields: Record<string, unknown>) => ({
				id: "combo-1",
				...fields,
			}),
			deleteCombo: async (id: string) => {
				deleted.push(id);
			},
			// Mirrors the real repository: a DELETE resolves to the removed slot's
			// account id, or null when it matched no row.
			removeComboSlot: async (id: string) => {
				const slot = (opts.slots ?? []).find((s) => s.id === id);
				if (!slot) return null;
				removed.push(id);
				return slot.account_id;
			},
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: minimal DatabaseOperations mock
const asOps = (o: unknown) => o as any;

const pinnedSlot: Slot = {
	id: "slot-1",
	combo_id: "combo-1",
	account_id: "acc-1",
	model: "old-pin",
	priority: 0,
	enabled: true,
};

function jsonReq(method: string, url: string, body?: unknown) {
	return new Request(url, { method, body: JSON.stringify(body ?? {}) });
}

afterEach(() => {
	clearVisionCapability();
});

describe("adding a combo slot", () => {
	it("drops the account's learned refusals when the slot pins a model", async () => {
		const db = makeDbOps();
		markVisionUnsupported("acc-1", "gpt-x");
		markVisionUnsupported("acc-unrelated", "gpt-x");

		const res = await createSlotAddHandler(asOps(db.ops))(
			jsonReq("POST", "http://local/api/combos/combo-1/slots", {
				account_id: "acc-1",
				model: "gpt-x",
			}),
			"combo-1",
		);

		expect(res.status).toBe(201);
		expect(isVisionUnsupported("acc-1", "gpt-x")).toBe(false);
		// Account-scoped: another account's entry for the same model is untouched.
		expect(isVisionUnsupported("acc-unrelated", "gpt-x")).toBe(true);
	});

	it("leaves the cache alone for a passthrough slot", async () => {
		// Anthropic, because only accounts serving Claude model ids accept a
		// passthrough slot at all (see combo-slot-model-required.test.ts).
		const db = makeDbOps({ provider: "anthropic" });
		markVisionUnsupported("acc-1", "gpt-x");

		const res = await createSlotAddHandler(asOps(db.ops))(
			jsonReq("POST", "http://local/api/combos/combo-1/slots", {
				account_id: "acc-1",
			}),
			"combo-1",
		);

		expect(res.status).toBe(201);
		expect(isVisionUnsupported("acc-1", "gpt-x")).toBe(true);
	});

	it("leaves the cache alone when the insert is refused", async () => {
		// A slot with no model on a codex account fails validation before the insert.
		const db = makeDbOps();
		markVisionUnsupported("acc-1", "gpt-x");

		const res = await createSlotAddHandler(asOps(db.ops))(
			jsonReq("POST", "http://local/api/combos/combo-1/slots", {
				account_id: "acc-1",
			}),
			"combo-1",
		);

		expect(res.status).toBe(400);
		expect(db.added).toHaveLength(0);
		expect(isVisionUnsupported("acc-1", "gpt-x")).toBe(true);
	});
});

describe("updating a combo's enabled flag", () => {
	it("drops the cache when the combo is actually disabled", async () => {
		const db = makeDbOps({ enabled: true });
		markVisionUnsupported("acc-1", "old-pin");

		const res = await createComboUpdateHandler(asOps(db.ops))(
			jsonReq("PUT", "http://local/api/combos/combo-1", { enabled: false }),
			"combo-1",
		);

		expect(res.status).toBe(200);
		expect(isVisionUnsupported("acc-1", "old-pin")).toBe(false);
	});

	it("leaves the cache alone for a rename", async () => {
		const db = makeDbOps({ enabled: true });
		markVisionUnsupported("acc-1", "old-pin");

		const res = await createComboUpdateHandler(asOps(db.ops))(
			jsonReq("PUT", "http://local/api/combos/combo-1", { name: "renamed" }),
			"combo-1",
		);

		expect(res.status).toBe(200);
		expect(isVisionUnsupported("acc-1", "old-pin")).toBe(true);
	});

	it("leaves the cache alone when the flag is written with the value it already has", async () => {
		const db = makeDbOps({ enabled: true });
		markVisionUnsupported("acc-1", "old-pin");

		const res = await createComboUpdateHandler(asOps(db.ops))(
			jsonReq("PUT", "http://local/api/combos/combo-1", { enabled: true }),
			"combo-1",
		);

		expect(res.status).toBe(200);
		expect(isVisionUnsupported("acc-1", "old-pin")).toBe(true);
	});
});

describe("removing a combo slot", () => {
	it("drops the cache when a slot was actually removed", async () => {
		const db = makeDbOps({ slots: [pinnedSlot] });
		markVisionUnsupported("acc-1", "old-pin");
		markVisionUnsupported("acc-unrelated", "old-pin");

		const res = await createSlotRemoveHandler(asOps(db.ops))(
			"combo-1",
			"slot-1",
		);

		expect(res.status).toBe(200);
		expect(db.removed).toEqual(["slot-1"]);
		expect(isVisionUnsupported("acc-1", "old-pin")).toBe(false);
		// Scoped to the removed slot's account: another account's learned
		// refusal is still true and survives.
		expect(isVisionUnsupported("acc-unrelated", "old-pin")).toBe(true);
	});

	// A repeated DELETE (double-click, retried request, stale dashboard row)
	// matches no slot, so no route changed and the unrelated learned refusals
	// must survive: clearing them would make every blind pair pay a fresh
	// re-learn round-trip for nothing.
	it("leaves the cache alone when the slot was already gone", async () => {
		const db = makeDbOps({ slots: [] });
		markVisionUnsupported("acc-1", "old-pin");

		const res = await createSlotRemoveHandler(asOps(db.ops))(
			"combo-1",
			"slot-gone",
		);

		expect(res.status).toBe(200);
		expect(db.removed).toEqual([]);
		expect(isVisionUnsupported("acc-1", "old-pin")).toBe(true);
	});
});

describe("deleting a combo", () => {
	it("drops the cache", async () => {
		const db = makeDbOps({ slots: [pinnedSlot] });
		markVisionUnsupported("acc-1", "old-pin");

		const res = await createComboDeleteHandler(asOps(db.ops))("combo-1");

		expect(res.status).toBe(200);
		expect(db.deleted).toEqual(["combo-1"]);
		expect(isVisionUnsupported("acc-1", "old-pin")).toBe(false);
	});
});
