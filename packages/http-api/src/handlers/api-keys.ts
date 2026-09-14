import {
	deleteApiKey,
	disableApiKey,
	enableApiKey,
	generateApiKey,
	getApiKey,
	listApiKeys,
	updateApiKeyRestrictions,
	updateApiKeyRole,
} from "@better-ccflare/cli-commands";
import type { DatabaseOperations } from "@better-ccflare/database";
import { BadRequest, NotFound } from "@better-ccflare/errors";
import {
	type ApiKeyGenerationResult,
	type ApiKeyRestrictions,
	PROVIDER_NAMES,
} from "@better-ccflare/types";
import { errorResponse } from "../utils/http-error";

/** The authoritative provider list — the same 19 names the accounts table uses. */
const PROVIDER_NAME_VALUES: readonly string[] = Object.values(PROVIDER_NAMES);

/**
 * Validate one restriction list out of a request body.
 *
 * Hand-rolled, in the shape of core's `validateString(..., { allowedValues })`
 * — there is no zod in this repo.
 *
 * The one thing this must never do is blur `null` into `[]`: `null` is
 * unrestricted and `[]` denies every request, so an absent value and an empty
 * array are different instructions and both are legal.
 */
function validateRestrictionList(
	value: unknown,
	field: string,
	options: { allowedValues?: readonly string[] } = {},
): string[] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value)) {
		throw BadRequest(`${field} must be an array of strings, or null`);
	}

	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") {
			throw BadRequest(`${field} entries must be strings`);
		}
		const trimmed = entry.trim();
		if (trimmed.length === 0) {
			throw BadRequest(`${field} entries must be non-empty strings`);
		}
		if (options.allowedValues && !options.allowedValues.includes(trimmed)) {
			throw BadRequest(
				`${field} must be one of: ${options.allowedValues.join(", ")}`,
			);
		}
		// De-duplicate: a repeated entry means exactly what a single one means,
		// and storing it twice only makes the stored JSON misleading.
		seen.add(trimmed);
	}
	return [...seen];
}

/**
 * Read the three restriction lists out of a body.
 *
 * `requireAll` is what separates the two callers: PATCH replaces the complete
 * restriction set, so silently reading an omitted field as `null` there would
 * let a partial body clear restrictions the caller never mentioned. Create has
 * no prior state to clear, so an omitted field there simply means unrestricted.
 */
function readRestrictions(
	body: Record<string, unknown>,
	requireAll: boolean,
): ApiKeyRestrictions {
	if (requireAll) {
		for (const field of [
			"allowedAccounts",
			"allowedModels",
			"allowedProviders",
		]) {
			if (!(field in body)) {
				throw BadRequest(
					`${field} is required (send null for unrestricted, or [] to deny all)`,
				);
			}
		}
	}

	return {
		allowedAccounts: validateRestrictionList(
			body.allowedAccounts,
			"allowedAccounts",
		),
		allowedModels: validateRestrictionList(body.allowedModels, "allowedModels"),
		allowedProviders: validateRestrictionList(
			body.allowedProviders,
			"allowedProviders",
			{ allowedValues: PROVIDER_NAME_VALUES },
		),
	};
}

export function createApiKeysListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const apiKeys = await listApiKeys(dbOps);
			const response = {
				success: true,
				data: apiKeys,
				count: apiKeys.length,
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

export function createApiKeysGenerateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const { name, role = "api-only" } = body;

			if (!name || typeof name !== "string" || name.trim().length === 0) {
				return errorResponse(
					BadRequest("Name is required and must be a non-empty string"),
				);
			}

			// Validate role
			if (role !== "admin" && role !== "api-only") {
				return errorResponse(
					BadRequest("Role must be either 'admin' or 'api-only'"),
				);
			}

			const restrictions = readRestrictions(
				body as Record<string, unknown>,
				false,
			);

			const result = await generateApiKey(
				dbOps,
				name.trim(),
				role,
				restrictions,
			);
			const response: ApiKeyGenerationResult = {
				id: result.id,
				name: result.name,
				apiKey: result.apiKey, // Full key shown only once
				prefixLast8: result.prefixLast8,
				createdAt: result.createdAt,
				role: result.role,
			};

			return new Response(JSON.stringify({ success: true, data: response }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyGetHandler(dbOps: DatabaseOperations) {
	return (name: string): Response => {
		try {
			const apiKey = getApiKey(dbOps, name);
			if (!apiKey) {
				return errorResponse(NotFound(`API key '${name}' not found`));
			}

			const response = {
				success: true,
				data: apiKey,
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

export function createApiKeyDisableHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await disableApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' disabled successfully`,
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

export function createApiKeyEnableHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await enableApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' enabled successfully`,
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

export function createApiKeyDeleteHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, name: string): Promise<Response> => {
		try {
			await deleteApiKey(dbOps, name);
			const response = {
				success: true,
				message: `API key '${name}' deleted successfully`,
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

export function createApiKeysStatsHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const total = await dbOps.countAllApiKeys();
			const active = await dbOps.countActiveApiKeys();
			const inactive = total - active;

			const response = {
				success: true,
				data: {
					total,
					active,
					inactive,
				},
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

export function createApiKeyUpdateRoleHandler(dbOps: DatabaseOperations) {
	return async (
		req: Request,
		keyId: string,
		currentApiKeyId?: string,
	): Promise<Response> => {
		try {
			const body = await req.json();
			const { role } = body;

			if (!role || (role !== "admin" && role !== "api-only")) {
				return errorResponse(
					BadRequest("Role must be either 'admin' or 'api-only'"),
				);
			}

			await updateApiKeyRole(dbOps, keyId, role, currentApiKeyId);
			const response = {
				success: true,
				message: `API key role updated to '${role}' successfully`,
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

export function createApiKeyUpdateRestrictionsHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, keyIdOrName: string): Promise<Response> => {
		try {
			const body = (await req.json()) as Record<string, unknown>;
			const restrictions = readRestrictions(body, true);

			await updateApiKeyRestrictions(dbOps, keyIdOrName, restrictions);

			const response = {
				success: true,
				message: "API key restrictions updated successfully",
				data: restrictions,
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
