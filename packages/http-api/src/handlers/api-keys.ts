import {
	deleteApiKey,
	disableApiKey,
	enableApiKey,
	generateApiKey,
	listApiKeys,
	updateApiKeyRestrictions,
	updateApiKeyRole,
	updateApiKeySpendLimit,
} from "@better-ccflare/cli-commands";
import { KNOWN_PATTERNS } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { BadRequest, NotFound } from "@better-ccflare/errors";
import { Logger } from "@better-ccflare/logger";
import {
	getApiKeySpendCounter,
	tryGetApiKeySpendCounter,
} from "@better-ccflare/proxy";
import {
	API_KEY_LIMIT_ENFORCEMENTS,
	API_KEY_SPEND_WINDOWS,
	type ApiKeyGenerationResult,
	type ApiKeyLimitInput,
	type ApiKeyLimitWindowMode,
	type ApiKeyResponse,
	type ApiKeyRestrictions,
	type ApiKeySpendLimit,
	DEFAULT_LIMIT_ENFORCEMENT,
	DEFAULT_SPEND_WINDOW,
	PROVIDER_NAMES,
	toApiKeyResponse,
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

/**
 * Read a spend limit out of a request body.
 *
 * Hand-rolled, because there is no zod here and because core's
 * `validateNumber` COERCES numeric strings: it would accept `"200"` as 200.
 * This rejects it. A price or a budget arriving as a string is a caller bug
 * worth surfacing, not something to quietly guess at — the same call the
 * sibling account plan-price handler made, and the two stay consistent.
 *
 * `null` on `limitUsd` clears the limit, and takes the window and the
 * enforcement mode with it. A MISSING `limitUsd` is a malformed request, not
 * a clear: a PATCH that forgot the field must not silently delete a budget.
 *
 * Zero is rejected along with negatives. "Spend nothing" is what disabling a
 * key means; accepting it as a budget would turn a fat-fingered 0 into a key
 * that refuses everything and reports a spend limit as the reason.
 */
function readSpendLimit(
	body: Record<string, unknown>,
): ApiKeySpendLimit | null {
	const rawLimit = body.limitUsd;
	if (rawLimit === undefined) {
		throw BadRequest("limitUsd is required (send null to clear the limit)");
	}
	if (rawLimit === null) return null;
	if (typeof rawLimit !== "number") {
		throw BadRequest("limitUsd must be a number or null");
	}
	if (!Number.isFinite(rawLimit)) {
		// Catches NaN and ±Infinity, neither of which any backend can store
		// sanely and neither of which could ever be compared against a total.
		throw BadRequest("limitUsd must be a finite number");
	}
	if (rawLimit <= 0) {
		throw BadRequest("limitUsd must be greater than 0");
	}

	return {
		limitUsd: rawLimit,
		limitWindow: validateEnum(
			body.limitWindow,
			"limitWindow",
			API_KEY_SPEND_WINDOWS,
			DEFAULT_SPEND_WINDOW,
		),
		limitEnforce: validateEnum(
			body.limitEnforce,
			"limitEnforce",
			API_KEY_LIMIT_ENFORCEMENTS,
			DEFAULT_LIMIT_ENFORCEMENT,
		),
	};
}

/**
 * One enum field: null/undefined takes the documented default, anything else
 * must be one of the allowed values exactly. No trimming and no case folding
 * — these are machine values from a `<select>`, not human input, and quietly
 * accepting `"Block "` would make the stored value depend on the client.
 */
function validateEnum<T extends string>(
	value: unknown,
	field: string,
	allowed: readonly T[],
	fallback: T,
): T {
	if (value === null || value === undefined) return fallback;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw BadRequest(`${field} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

/**
 * Attach every child limit and its live spend to each key.
 *
 * Read from the SAME in-memory counter the proxy enforces against, so the
 * gauge and the refusal can never disagree, and so the dashboard's polling
 * does not re-run the expensive rollup on every poll. Unknown spend is left
 * absent when a counter could not be loaded.
 *
 * Failures are swallowed per key. The list endpoint is how an operator finds
 * and fixes a broken key; it must not 500 because a spend total could not be
 * computed.
 */
export async function withSpendUsage(
	dbOps: DatabaseOperations,
	apiKeys: ApiKeyResponse[],
): Promise<ApiKeyResponse[]> {
	const counter = getApiKeySpendCounter(dbOps);
	const now = Date.now();
	await Promise.all(
		apiKeys.map(async (key) => {
			const limits = await counter.getLimitsForKey(key.id);
			key.limits = await Promise.all(
				limits.map(async (limit) => {
					try {
						const snapshot = await counter.getLimitSnapshot(
							key.id,
							limit,
							key.limitWindowMode ?? "calendar",
							now,
						);
						return {
							...limit,
							spentUsd: snapshot.spentUsd,
							resetsAt:
								snapshot.resetMs == null
									? null
									: new Date(snapshot.resetMs).toISOString(),
						};
					} catch {
						return { ...limit, resetsAt: null };
					}
				}),
			);
		}),
	);
	for (const key of apiKeys) {
		const legacy = key.limits?.find(
			(limit) =>
				limit.scopeModel === null &&
				limit.window === (key.limitWindow === "rolling_7d" ? "week" : "month"),
		);
		if (key.limitUsd != null && legacy) {
			key.spentUsd = legacy.spentUsd;
			key.windowResetsAt = legacy.resetsAt;
		}
	}
	return apiKeys;
}

export function createApiKeysListHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			const apiKeys = await withSpendUsage(dbOps, await listApiKeys(dbOps));
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

			// A create body may omit limitUsd entirely, unlike PATCH: there is no
			// prior budget for an omission to silently clear.
			const spendLimit =
				(body as Record<string, unknown>).limitUsd === undefined
					? null
					: readSpendLimit(body as Record<string, unknown>);

			const result = await generateApiKey(
				dbOps,
				name.trim(),
				role,
				restrictions,
				spendLimit,
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
	return async (name: string): Promise<Response> => {
		try {
			const key = await resolveKey(dbOps, name);
			const [apiKey] = await withSpendUsage(dbOps, [toApiKeyResponse(key)]);

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

export function createApiKeyUpdateSpendLimitHandler(dbOps: DatabaseOperations) {
	return async (req: Request, keyIdOrName: string): Promise<Response> => {
		try {
			const body = (await req.json()) as Record<string, unknown>;
			const spendLimit = readSpendLimit(body);

			const keyId = await updateApiKeySpendLimit(
				dbOps,
				keyIdOrName,
				spendLimit,
			);

			// Drop the cached total. The counter caches the window the total was
			// measured over, so a key whose window just changed from 7d to
			// calendar-month would otherwise keep answering from the old one
			// until the next resync. `tryGet` because a CLI-only process has no
			// counter and does not need one created here.
			tryGetApiKeySpendCounter()?.forget(keyId);

			const response = {
				success: true,
				message: spendLimit
					? "API key spend limit updated successfully"
					: "API key spend limit cleared",
				data: spendLimit,
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

async function resolveKey(dbOps: DatabaseOperations, idOrName: string) {
	const key =
		(await dbOps.getApiKey(idOrName)) ??
		(await dbOps.getApiKeyByName(idOrName));
	if (!key) throw NotFound(`API key '${idOrName}' not found`);
	return key;
}

function readLimitRows(body: Record<string, unknown>): {
	mode: ApiKeyLimitWindowMode;
	limits: ApiKeyLimitInput[];
} {
	if (body.mode !== "calendar" && body.mode !== "rolling") {
		throw BadRequest("mode must be calendar or rolling");
	}
	if (!Array.isArray(body.limits)) throw BadRequest("limits must be an array");
	const seen = new Set<string>();
	const limits = body.limits.map((raw): ApiKeyLimitInput => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw BadRequest("Each limit must be an object");
		}
		const row = raw as Record<string, unknown>;
		const scopeModel = row.scopeModel ?? null;
		if (
			scopeModel !== null &&
			(typeof scopeModel !== "string" ||
				!scopeModel.trim() ||
				scopeModel !== scopeModel.trim() ||
				/\s/.test(scopeModel) ||
				[...scopeModel].some((char) => char.charCodeAt(0) < 32))
		) {
			throw BadRequest(
				"scopeModel must be null, an exact model id, or a family name",
			);
		}
		const window = validateEnum(
			row.window,
			"window",
			["hour", "day", "week", "month"] as const,
			"month",
		);
		if (row.window == null) throw BadRequest("window is required");
		if (
			typeof row.limitUsd !== "number" ||
			!Number.isFinite(row.limitUsd) ||
			row.limitUsd <= 0
		) {
			throw BadRequest("limitUsd must be a finite number greater than 0");
		}
		const enforce = validateEnum(
			row.enforce,
			"enforce",
			API_KEY_LIMIT_ENFORCEMENTS,
			"block",
		);
		const identity = JSON.stringify([scopeModel, window]);
		if (seen.has(identity))
			throw BadRequest("Only one limit is allowed per model scope and window");
		seen.add(identity);
		return { scopeModel, window, limitUsd: row.limitUsd, enforce };
	});
	return { mode: body.mode, limits };
}

export function createApiKeyLimitsGetHandler(dbOps: DatabaseOperations) {
	return async (idOrName: string): Promise<Response> => {
		try {
			const key = await resolveKey(dbOps, idOrName);
			const [response] = await withSpendUsage(dbOps, [toApiKeyResponse(key)]);
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						mode: key.limitWindowMode ?? "calendar",
						limits: response.limits ?? [],
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyLimitsPutHandler(dbOps: DatabaseOperations) {
	return async (req: Request, idOrName: string): Promise<Response> => {
		try {
			const body: unknown = await req.json();
			if (!body || typeof body !== "object" || Array.isArray(body))
				throw BadRequest("Expected a limits object");
			const { mode, limits } = readLimitRows(body as Record<string, unknown>);
			const key = await resolveKey(dbOps, idOrName);
			await dbOps.replaceApiKeyLimits(key.id, limits, mode);
			tryGetApiKeySpendCounter()?.forget(key.id);
			return await createApiKeyLimitsGetHandler(dbOps)(key.id);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

export function createApiKeyRoutingUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, idOrName: string): Promise<Response> => {
		try {
			const body: unknown = await req.json();
			if (
				!body ||
				typeof body !== "object" ||
				Array.isArray(body) ||
				!("familyComboOverrides" in body)
			) {
				throw BadRequest(
					"familyComboOverrides is required (send null to use global routing)",
				);
			}
			const overrides = (body as Record<string, unknown>).familyComboOverrides;
			if (
				overrides !== null &&
				(typeof overrides !== "object" || Array.isArray(overrides))
			) {
				throw BadRequest("familyComboOverrides must be an object or null");
			}
			const mapping: Record<string, string> | null =
				overrides === null ? null : {};
			for (const [family, comboId] of Object.entries(overrides ?? {})) {
				if (!(KNOWN_PATTERNS as readonly string[]).includes(family))
					throw BadRequest("Unknown model family");
				if (typeof comboId !== "string" || !comboId.trim())
					throw BadRequest("Each routing override must name a combo id");
				const combo = await dbOps.getCombo(comboId);
				if (!combo) throw BadRequest(`Combo '${comboId}' not found`);
				if (!combo.enabled) throw BadRequest(`Combo '${comboId}' is disabled`);
				if (mapping) mapping[family] = comboId;
			}
			const key = await resolveKey(dbOps, idOrName);
			await dbOps.updateApiKeyRouting(key.id, mapping);
			return new Response(
				JSON.stringify({
					success: true,
					data: { familyComboOverrides: mapping },
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** Admin reset: persist first, then replace the live accounting boundary immediately. */
export function createApiKeyResetSpendHandler(dbOps: DatabaseOperations) {
	return async (idOrName: string, actor: string): Promise<Response> => {
		try {
			const key = await resolveKey(dbOps, idOrName);
			const resetAt = Date.now();
			if (!(await dbOps.resetApiKeySpend(key.id, resetAt, actor)))
				throw NotFound(`API key '${idOrName}' not found`);
			// A concurrent reset may have persisted a later boundary while this
			// request was writing; always publish the persisted winner.
			const updated = await resolveKey(dbOps, key.id);
			getApiKeySpendCounter(dbOps).applySpendReset(
				key.id,
				updated.spendResetAt ?? resetAt,
			);
			new Logger("ApiKeySpendReset").info(
				`Spend reset for API key ${key.name} (${key.id}) at ${new Date(updated.spendResetAt ?? resetAt).toISOString()} by ${updated.spendResetBy ?? actor}`,
			);
			const [data] = await withSpendUsage(dbOps, [toApiKeyResponse(updated)]);
			return new Response(
				JSON.stringify({
					success: true,
					data,
					message: `Spend reset for ${key.name}; limits and usage history kept.`,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** CLI notification only: load an already-persisted reset without changing it. */
export function createApiKeyReloadSpendHandler(dbOps: DatabaseOperations) {
	return async (idOrName: string): Promise<Response> => {
		try {
			const key = await resolveKey(dbOps, idOrName);
			if (key.spendResetAt != null)
				getApiKeySpendCounter(dbOps).applySpendReset(key.id, key.spendResetAt);
			return new Response(JSON.stringify({ success: true }), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}
