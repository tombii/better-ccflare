import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	markModelCooling,
	resetModelCooldownsForTests,
} from "@better-ccflare/proxy";
import type { ComboSlotWithCooldown } from "@better-ccflare/types";
import { createComboGetHandler } from "../combos";

/**
 * GET /api/combos/:id is the read path the dashboard uses to show each slot's
 * model-scoped cooldown. It must decorate the stored slots with the in-memory
 * deadline (`cooldown_until`) without ever writing that field back.
 */

const NOW = Date.now();

function makeDbOps(modelMappings: string | null = null) {
	const slots = [
		{
			id: "slot-1",
			combo_id: "combo-1",
			account_id: "acc-1",
			model: "claude-sonnet-4-5",
			priority: 0,
			enabled: true,
		},
		{
			id: "slot-2",
			combo_id: "combo-1",
			account_id: "acc-2",
			model: "claude-sonnet-4-5",
			priority: 1,
			enabled: true,
		},
	];
	return {
		slots,
		ops: {
			getCombo: async () => ({
				id: "combo-1",
				name: "C",
				description: null,
				enabled: true,
				created_at: NOW,
				updated_at: NOW,
			}),
			getComboSlots: async () => slots,
			getAllAccounts: async () => [
				{ id: "acc-1", provider: "anthropic", model_mappings: modelMappings },
				{ id: "acc-2", provider: "anthropic", model_mappings: null },
			],
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: minimal DatabaseOperations mock
const asOps = (o: unknown) => o as any;

beforeEach(() => {
	resetModelCooldownsForTests();
});

afterEach(() => {
	resetModelCooldownsForTests();
});

describe("GET /api/combos/:id — slot cooldown_until", () => {
	it("reads the mapped upstream cooldown while leaving passthrough unmatched", async () => {
		const until = Date.now() + 60_000;
		markModelCooling("acc-1", "upstream-sonnet", until);
		const fixture = makeDbOps(JSON.stringify({ sonnet: "upstream-sonnet" }));
		fixture.slots[1].account_id = "acc-1";
		fixture.slots[1].model = "";

		const res = await createComboGetHandler(asOps(fixture.ops))("combo-1");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { slots: ComboSlotWithCooldown[] };
		};
		expect(body.data.slots.map((s) => s.cooldown_until)).toEqual([until, null]);
	});

	it("reports the deadline for a cooled slot and null otherwise", async () => {
		const until = Date.now() + 10 * 60 * 1000;
		markModelCooling("acc-1", "claude-sonnet-4-5", until);

		const res = await createComboGetHandler(asOps(makeDbOps().ops))("combo-1");
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			success: boolean;
			data: { slots: ComboSlotWithCooldown[] };
		};
		expect(body.success).toBe(true);
		expect(body.data.slots.map((s) => s.cooldown_until)).toEqual([until, null]);
		// Existing slot fields survive the decoration.
		expect(body.data.slots[0]).toMatchObject({
			id: "slot-1",
			account_id: "acc-1",
			model: "claude-sonnet-4-5",
			priority: 0,
			enabled: true,
		});
	});

	it("reports null for every slot when nothing is cooling", async () => {
		const res = await createComboGetHandler(asOps(makeDbOps().ops))("combo-1");
		const body = (await res.json()) as {
			data: { slots: ComboSlotWithCooldown[] };
		};

		expect(body.data.slots.map((s) => s.cooldown_until)).toEqual([null, null]);
	});
});
