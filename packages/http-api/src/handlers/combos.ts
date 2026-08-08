import type { DatabaseOperations } from "@better-ccflare/database";
import { BadRequest, NotFound } from "@better-ccflare/errors";
import type {
	ComboFamily,
	ComboFamilyAssignment,
	ComboWithSlots,
} from "@better-ccflare/types";
import { errorResponse } from "../utils/http-error";

/**
 * Providers whose upstream natively accepts Claude model ids. Only for these
 * does a slot without a model (passthrough) make sense: the model the client
 * asked for arrives intact and is understood on the other side.
 *
 * On any other provider, passthrough would hand a Claude name to an upstream
 * that does not know it, and translation would fall to the embedded default
 * map — the path that produced `400 gpt-5.3-codex ... ChatGPT account`.
 */
const PROVIDERS_ACCEPTING_CLIENT_MODEL = new Set([
	"anthropic",
	"claude-console-api",
]);

function allowsClientModel(provider: string | null | undefined): boolean {
	return PROVIDERS_ACCEPTING_CLIENT_MODEL.has(provider ?? "anthropic");
}

/**
 * GET /api/combos — List all combos with slot counts (lightweight)
 */
export function createCombosListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const combos = await dbOps.listCombos();
			const data = await Promise.all(
				combos.map(async (combo) => {
					const slots = await dbOps.getComboSlots(combo.id);
					return {
						id: combo.id,
						name: combo.name,
						description: combo.description,
						enabled: combo.enabled,
						slot_count: slots.length,
					};
				}),
			);
			const response = {
				success: true,
				data,
				count: data.length,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * POST /api/combos — Create a new combo
 */
export function createComboCreateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const { name, description } = body;

			if (!name || typeof name !== "string" || name.trim().length === 0) {
				return errorResponse(
					BadRequest("name is required and must be a non-empty string"),
				);
			}

			const combo = await dbOps.createCombo(name.trim(), description ?? null);
			const response = {
				success: true,
				data: combo,
			};

			return new Response(JSON.stringify(response), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * GET /api/combos/:id — Get combo detail with populated slots
 */
export function createComboGetHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(id);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			const slots = await dbOps.getComboSlots(id);
			const data: ComboWithSlots = { ...combo, slots };
			const response = {
				success: true,
				data,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/combos/:id — Update combo fields
 */
export function createComboUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, id: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(id);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			const body = await req.json();
			const { name, description, enabled } = body;

			const fields: Partial<{
				name: string;
				description: string | null;
				enabled: boolean;
			}> = {};

			if (name !== undefined) {
				if (typeof name !== "string" || name.trim().length === 0) {
					return errorResponse(BadRequest("name must be a non-empty string"));
				}
				fields.name = name.trim();
			}

			if (description !== undefined) {
				fields.description = description;
			}

			if (enabled !== undefined) {
				fields.enabled = enabled;
			}

			const updated = await dbOps.updateCombo(id, fields);
			const response = {
				success: true,
				data: updated,
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * DELETE /api/combos/:id — Delete combo (cascades slots via DB)
 */
export function createComboDeleteHandler(dbOps: DatabaseOperations) {
	return async (id: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(id);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			await dbOps.deleteCombo(id);
			const response = {
				success: true,
				message: "Combo deleted successfully",
			};

			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * POST /api/combos/:id/slots — Add a slot to a combo
 */
export function createSlotAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request, comboId: string): Promise<Response> => {
		try {
			const combo = await dbOps.getCombo(comboId);
			if (!combo) {
				return errorResponse(NotFound("Combo not found"));
			}

			const body = await req.json();
			const { account_id, model } = body;

			if (
				!account_id ||
				typeof account_id !== "string" ||
				account_id.trim().length === 0
			) {
				return errorResponse(BadRequest("account_id is required"));
			}

			// `model` is optional: a slot with no model means passthrough — the
			// model the client asked for goes upstream untouched. We store an
			// empty string (not NULL) because combo_slots.model is NOT NULL and the
			// unique index (combo_id, account_id, model) only blocks duplicates with "".
			if (model !== undefined && model !== null && typeof model !== "string") {
				return errorResponse(
					BadRequest("model must be a string when provided"),
				);
			}
			const slotModel = typeof model === "string" ? model.trim() : "";

			// Passthrough only holds where the upstream speaks the same model
			// namespace as the client. See PROVIDERS_ACCEPTING_CLIENT_MODEL.
			if (slotModel.length === 0) {
				const account = await dbOps.getAccount(account_id);
				if (account && !allowsClientModel(account.provider)) {
					return errorResponse(
						BadRequest(
							`model is required for provider "${account.provider}": only accounts that serve Claude model ids can forward the client model unchanged`,
						),
					);
				}
			}

			const existingSlots = await dbOps.getComboSlots(comboId);
			const nextPriority = existingSlots.length;
			const newSlot = await dbOps.addComboSlot(
				comboId,
				account_id,
				slotModel,
				nextPriority,
			);

			return new Response(JSON.stringify({ success: true, data: newSlot }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/combos/:id/slots/:slotId — Update a slot's model or enabled status
 */
export function createSlotUpdateHandler(dbOps: DatabaseOperations) {
	return async (
		req: Request,
		_comboId: string,
		slotId: string,
	): Promise<Response> => {
		try {
			const body = await req.json();
			const { model, enabled } = body;

			const fields: Partial<{
				model: string;
				enabled: boolean;
			}> = {};

			if (model !== undefined) {
				// An empty string clears the override and makes the slot passthrough.
				if (typeof model !== "string") {
					return errorResponse(BadRequest("model must be a string"));
				}
				fields.model = model.trim();

				// Same rule as the POST, now for whoever clears a slot that already
				// exists: without it, the validation could be bypassed in two steps.
				if (fields.model.length === 0) {
					const slots = await dbOps.getComboSlots(_comboId);
					const slot = slots.find((s) => s.id === slotId);
					// A slot id that this combo does not own must not silently skip
					// the check: updateComboSlot resolves the slot globally, so a
					// mismatched combo id in the path would let an incompatible slot
					// become passthrough.
					if (!slot) {
						return errorResponse(NotFound("Combo slot not found"));
					}
					{
						const account = await dbOps.getAccount(slot.account_id);
						if (account && !allowsClientModel(account.provider)) {
							return errorResponse(
								BadRequest(
									`model is required for provider "${account.provider}": only accounts that serve Claude model ids can forward the client model unchanged`,
								),
							);
						}
					}
				}
			}

			if (enabled !== undefined) {
				if (typeof enabled !== "boolean") {
					return errorResponse(BadRequest("enabled must be a boolean"));
				}
				fields.enabled = enabled;
			}

			const updatedSlot = await dbOps.updateComboSlot(slotId, fields);

			return new Response(
				JSON.stringify({ success: true, data: updatedSlot }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * DELETE /api/combos/:id/slots/:slotId — Remove a slot from a combo
 */
export function createSlotRemoveHandler(dbOps: DatabaseOperations) {
	return async (_comboId: string, slotId: string): Promise<Response> => {
		try {
			await dbOps.removeComboSlot(slotId);

			return new Response(
				JSON.stringify({ success: true, message: "Slot removed" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/combos/:id/slots/reorder — Reorder slots by priority
 */
export function createSlotReorderHandler(dbOps: DatabaseOperations) {
	return async (req: Request, comboId: string): Promise<Response> => {
		try {
			const body = await req.json();
			const { slotIds } = body;

			if (!Array.isArray(slotIds)) {
				return errorResponse(
					BadRequest("slotIds must be an array of slot IDs"),
				);
			}

			await dbOps.reorderComboSlots(comboId, slotIds);

			return new Response(
				JSON.stringify({ success: true, message: "Slots reordered" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * GET /api/families — List all family-to-combo assignments
 */
export function createFamiliesListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const assignments: ComboFamilyAssignment[] =
				await dbOps.getFamilyAssignments();

			return new Response(
				JSON.stringify({ success: true, data: assignments }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/families/:family — Assign or unassign a combo to a family
 */
export function createFamilyAssignHandler(dbOps: DatabaseOperations) {
	return async (req: Request, family: string): Promise<Response> => {
		try {
			const validFamilies: ComboFamily[] = ["fable", "opus", "sonnet", "haiku"];
			if (!validFamilies.includes(family as ComboFamily)) {
				return errorResponse(
					BadRequest("family must be one of: fable, opus, sonnet, haiku"),
				);
			}

			const body = await req.json();
			const { combo_id, enabled: bodyEnabled } = body;

			let safeComboId: string | null = null;
			if (combo_id !== undefined && combo_id !== null) {
				if (typeof combo_id !== "string") {
					return errorResponse(BadRequest("combo_id must be a string"));
				}
				safeComboId = combo_id;
			}

			const enabled =
				bodyEnabled !== undefined ? !!bodyEnabled : safeComboId !== null;

			await dbOps.setFamilyCombo(family as ComboFamily, safeComboId, enabled);

			return new Response(
				JSON.stringify({
					success: true,
					message: "Family assignment updated",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}
