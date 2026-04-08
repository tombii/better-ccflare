import type { DatabaseOperations } from "@better-ccflare/database";
import { BadRequest, NotFound } from "@better-ccflare/errors";
import type { Combo, ComboWithSlots } from "@better-ccflare/types";
import { errorResponse } from "../utils/http-error";

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

			if (
				!name ||
				typeof name !== "string" ||
				name.trim().length === 0
			) {
				return errorResponse(
					BadRequest(
						"name is required and must be a non-empty string",
					),
				);
			}

			const combo = await dbOps.createCombo(
				name.trim(),
				description ?? null,
			);
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
				if (
					typeof name !== "string" ||
					name.trim().length === 0
				) {
					return errorResponse(
						BadRequest("name must be a non-empty string"),
					);
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
