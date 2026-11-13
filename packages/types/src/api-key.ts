// Crypto interface for dependency injection

// API key role types
export type ApiKeyRole = "admin" | "api-only";

/**
 * Per-key restrictions on which accounts, models and providers a key may use.
 *
 * `null` on a field means UNRESTRICTED; `[]` means DENY-ALL. The distinction is
 * load-bearing and is the reason these are three nullable JSON-array TEXT
 * columns rather than a join table: with a join table, deleting the last
 * allowed account would empty the list and silently promote a restricted key
 * back to unrestricted. A dangling id left behind by a deleted account simply
 * matches nothing, which is the safe failure direction.
 */
export interface ApiKeyRestrictions {
	/** Account IDs this key may route to. null = any account. */
	allowedAccounts: string[] | null;
	/** Model IDs and/or family names ("opus") this key may request. null = any. */
	allowedModels: string[] | null;
	/** Provider names this key may route to. null = any provider. */
	allowedProviders: string[] | null;
}

export type ApiKeyLimitWindow = "hour" | "day" | "week" | "month";
export type ApiKeyLimitWindowMode = "calendar" | "rolling";
export const API_KEY_LIMIT_WINDOWS: readonly ApiKeyLimitWindow[] = [
	"hour",
	"day",
	"week",
	"month",
];
export const API_KEY_LIMIT_WINDOW_MODES: readonly ApiKeyLimitWindowMode[] = [
	"calendar",
	"rolling",
];
export interface ApiKeyLimitInput {
	scopeModel: string | null;
	window: ApiKeyLimitWindow;
	limitUsd: number;
	enforce: ApiKeyLimitEnforcement;
}
export interface ApiKeyLimit extends ApiKeyLimitInput {
	id: string;
	apiKeyId: string;
	createdAt: number;
	updatedAt: number;
}
export interface ApiKeyLimitStatus extends ApiKeyLimit {
	spentUsd?: number;
	resetsAt: string | null;
}

export function parseFamilyComboOverrides(
	raw: string | null | undefined,
): Record<string, string> | null {
	if (raw == null) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		return Object.fromEntries(
			Object.entries(value).filter(
				([family, id]) =>
					["fable", "opus", "sonnet", "haiku"].includes(family) &&
					typeof id === "string" &&
					id.length > 0,
			),
		);
	} catch {
		return null;
	}
}

// Database row type that matches actual database schema
export interface ApiKeyRow {
	limit_window_mode?: string;
	family_combo_overrides?: string | null;
	id: string;
	name: string;
	hashed_key: string;
	prefix_last_8: string;
	created_at: number;
	last_used: number | null;
	usage_count: number;
	is_active: boolean | number;
	role: ApiKeyRole;
	/** JSON array of account IDs, or NULL for unrestricted. */
	allowed_accounts?: string | null;
	/** JSON array of model IDs / family names, or NULL for unrestricted. */
	allowed_models?: string | null;
	/** JSON array of provider names, or NULL for unrestricted. */
	allowed_providers?: string | null;
	/** REAL dollar ceiling, or NULL for no limit. */
	limit_usd?: number | null;
	/** One of API_KEY_SPEND_WINDOWS, or NULL (defaults applied on read). */
	limit_window?: string | null;
	/** One of API_KEY_LIMIT_ENFORCEMENTS, or NULL (defaults applied on read). */
	limit_enforce?: string | null;
}

/**
 * Parse one restriction column into its domain form.
 *
 * Deliberately fails CLOSED: a column that is present but unreadable (corrupt
 * JSON, a JSON scalar instead of an array) becomes `[]` — deny-all — not
 * `null`. Returning `null` there would turn an unreadable restriction into a
 * silent privilege escalation, which is the one outcome this feature must
 * never produce. Non-string entries are dropped; they can only ever match
 * nothing anyway.
 */
export function parseRestrictionList(
	raw: string | null | undefined,
): string[] | null {
	if (raw == null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

/** Serialize one restriction list back to its TEXT column form. */
export function serializeRestrictionList(
	list: string[] | null | undefined,
): string | null {
	return list == null ? null : JSON.stringify(list);
}

/**
 * The window a per-key spend limit is measured over.
 *
 * Two rolling windows and one calendar window, because those are the two
 * things people actually mean by "a monthly budget": a moving 30-day trailing
 * total, or the bill that starts fresh on the 1st. The calendar window is NOT
 * a 30-day approximation of the rolling one and is not interchangeable with it.
 */
export type ApiKeySpendWindow = "rolling_7d" | "rolling_30d" | "calendar_month";

/** Every legal `limit_window` value, for validation and for the UI's select. */
export const API_KEY_SPEND_WINDOWS: readonly ApiKeySpendWindow[] = [
	"rolling_7d",
	"rolling_30d",
	"calendar_month",
] as const;

/** What happens when a key is over its limit. */
export type ApiKeyLimitEnforcement = "block" | "warn";

/** Every legal `limit_enforce` value. */
export const API_KEY_LIMIT_ENFORCEMENTS: readonly ApiKeyLimitEnforcement[] = [
	"block",
	"warn",
] as const;

/**
 * Applied when a limit is set but its window / enforcement column is NULL.
 *
 * NULL is legal in both columns and is not a validation failure: the limit
 * amount is the only thing a caller must supply. `rolling_30d` and `block` are
 * the defaults because a limit that quietly failed to block would be worse
 * than no limit at all, and 30 days is the window people mean by "budget".
 */
export const DEFAULT_SPEND_WINDOW: ApiKeySpendWindow = "rolling_30d";
export const DEFAULT_LIMIT_ENFORCEMENT: ApiKeyLimitEnforcement = "block";

/**
 * A key's resolved spend limit — the shape the proxy enforces against.
 *
 * Only ever constructed for a key that HAS a limit, so `limitUsd` is a plain
 * number here and the window/enforcement have already had their defaults
 * applied. A key with `limit_usd IS NULL` produces `null` instead (see
 * {@link toApiKeySpendLimit}), which is the value every hot path checks first.
 */
export interface ApiKeySpendLimit {
	/** Dollar ceiling, API-cost-equivalent. Always finite and > 0. */
	limitUsd: number;
	limitWindow: ApiKeySpendWindow;
	limitEnforce: ApiKeyLimitEnforcement;
}

/**
 * Narrow a stored window value, falling back to the default.
 *
 * Fails SOFT rather than closed, unlike {@link parseRestrictionList}: an
 * unreadable window is a measurement question, not a permission one, and the
 * safe answer is "measure over the default 30 days" rather than "deny".
 */
export function parseSpendWindow(
	raw: string | null | undefined,
): ApiKeySpendWindow {
	return API_KEY_SPEND_WINDOWS.includes(raw as ApiKeySpendWindow)
		? (raw as ApiKeySpendWindow)
		: DEFAULT_SPEND_WINDOW;
}

/**
 * Narrow a stored enforcement value, falling back to the default.
 *
 * Unreadable resolves to `block`: a limit whose enforcement column got
 * corrupted must not silently degrade into a limit that never refuses.
 */
export function parseLimitEnforcement(
	raw: string | null | undefined,
): ApiKeyLimitEnforcement {
	return API_KEY_LIMIT_ENFORCEMENTS.includes(raw as ApiKeyLimitEnforcement)
		? (raw as ApiKeyLimitEnforcement)
		: DEFAULT_LIMIT_ENFORCEMENT;
}

/**
 * Is this a usable limit amount?
 *
 * Shared by the row->domain coercion and the management API so a value that
 * could never be enforced can also never be stored. Zero is rejected on
 * purpose: "spend nothing" is what disabling the key means, and accepting it
 * as a limit would make a fat-fingered 0 look like a budget.
 */
export function isValidSpendLimitUsd(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Row value -> usable limit, or null.
 *
 * `Number(...)` first because a driver may hand a REAL column back as a
 * string (Bun.SQL does this for PostgreSQL NUMERIC); `isValidSpendLimitUsd`
 * then rejects everything that could not be enforced. Storage-layer only —
 * the management API deliberately does NOT coerce strings (see its handler).
 */
export function coerceSpendLimitUsd(value: unknown): number | null {
	if (value == null) return null;
	const numeric = Number(value);
	return isValidSpendLimitUsd(numeric) ? numeric : null;
}

// Domain model - used throughout the application
export interface ApiKey {
	limitWindowMode?: ApiKeyLimitWindowMode;
	familyComboOverrides?: Record<string, string> | null;
	id: string;
	name: string;
	hashedKey: string;
	prefixLast8: string;
	createdAt: number;
	lastUsed: number | null;
	usageCount: number;
	isActive: boolean;
	role: ApiKeyRole;
	allowedAccounts: string[] | null;
	allowedModels: string[] | null;
	allowedProviders: string[] | null;
	/** Spend ceiling in API-cost-equivalent dollars. null = no limit. */
	limitUsd: number | null;
	/** Window the limit is measured over. null only when limitUsd is null. */
	limitWindow: ApiKeySpendWindow | null;
	/** Block or warn. null only when limitUsd is null. */
	limitEnforce: ApiKeyLimitEnforcement | null;
}

// API response type - what clients receive (excluding sensitive data)
export interface ApiKeyResponse {
	limitWindowMode?: ApiKeyLimitWindowMode;
	familyComboOverrides?: Record<string, string> | null;
	limits?: ApiKeyLimitStatus[];
	id: string;
	name: string;
	prefixLast8: string;
	createdAt: string;
	lastUsed: string | null;
	usageCount: number;
	isActive: boolean;
	role: ApiKeyRole;
	allowedAccounts: string[] | null;
	allowedModels: string[] | null;
	allowedProviders: string[] | null;
	limitUsd: number | null;
	limitWindow: ApiKeySpendWindow | null;
	limitEnforce: ApiKeyLimitEnforcement | null;
	/**
	 * Spend so far in the current window, in the same dollars as `limitUsd`.
	 *
	 * OPTIONAL and computed, not stored: it is attached by the list endpoint
	 * from the live in-memory counter so the dashboard gauge needs no second
	 * round trip. Absent for a key with no limit, and absent from every other
	 * surface that builds an ApiKeyResponse.
	 */
	spentUsd?: number;
	/**
	 * ISO time at which this window's spend next falls — the start of next
	 * month for `calendar_month`, and the moment the oldest counted request
	 * ages out for the rolling windows. null when nothing is known to age out.
	 */
	windowResetsAt?: string | null;
}

/**
 * Narrow an API key down to just its restrictions, or `null` when the key
 * carries none at all.
 *
 * Returning `null` for a fully-unrestricted key is deliberate: it is the value
 * the proxy hot path checks first, so a key with all three columns NULL costs
 * one identity comparison and behaves exactly as it did before this feature
 * existed.
 */
export function toApiKeyRestrictions(
	apiKey: Pick<
		ApiKey,
		"allowedAccounts" | "allowedModels" | "allowedProviders"
	>,
): ApiKeyRestrictions | null {
	if (
		apiKey.allowedAccounts == null &&
		apiKey.allowedModels == null &&
		apiKey.allowedProviders == null
	) {
		return null;
	}
	return {
		allowedAccounts: apiKey.allowedAccounts,
		allowedModels: apiKey.allowedModels,
		allowedProviders: apiKey.allowedProviders,
	};
}

/**
 * Narrow an API key down to its spend limit, or `null` when it has none.
 *
 * Same contract as {@link toApiKeyRestrictions} and for the same reason: this
 * is what the proxy hot path checks first, so a key with `limit_usd IS NULL`
 * costs one identity comparison and behaves exactly as it did before this
 * feature existed. A stored limit that is not a usable number (0, negative,
 * NaN from a hand-edited row) also reads as "no limit" rather than as a
 * ceiling nothing could ever satisfy.
 */
export function toApiKeySpendLimit(
	apiKey: Pick<ApiKey, "limitUsd" | "limitWindow" | "limitEnforce">,
): ApiKeySpendLimit | null {
	if (!isValidSpendLimitUsd(apiKey.limitUsd)) return null;
	return {
		limitUsd: apiKey.limitUsd,
		limitWindow: apiKey.limitWindow ?? DEFAULT_SPEND_WINDOW,
		limitEnforce: apiKey.limitEnforce ?? DEFAULT_LIMIT_ENFORCEMENT,
	};
}

// API key generation result
export interface ApiKeyGenerationResult {
	id: string;
	name: string;
	apiKey: string; // Full API key (shown only once)
	prefixLast8: string;
	createdAt: string;
	role: ApiKeyRole;
}

// Input for creating API keys
export interface CreateApiKeyInput {
	name: string;
	role?: ApiKeyRole; // Optional, defaults to 'api-only'
	restrictions?: Partial<ApiKeyRestrictions>; // Optional, all-null = unrestricted
	spendLimit?: ApiKeySpendLimit | null; // Optional, null = no limit
}

// Validation result
export interface ApiKeyValidationResult {
	isValid: boolean;
	apiKey?: ApiKey;
	error?: string;
}

// Crypto interface for dependency injection
export interface CryptoUtils {
	generateApiKey(): Promise<string>;
	hashApiKey(apiKey: string): Promise<string>;
	verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean>;
}

// Default implementation using Node.js crypto
export class NodeCryptoUtils implements CryptoUtils {
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic require for Node.js crypto module compatibility
	private crypto: any;
	// biome-ignore lint/suspicious/noExplicitAny: promisify returns any-typed wrapper
	private scryptAsync: any;

	constructor() {
		// Import crypto dynamically to avoid issues with bundling
		this.crypto = require("node:crypto");
		const { promisify } = require("node:util");
		this.scryptAsync = promisify(this.crypto.scrypt);
	}

	async generateApiKey(): Promise<string> {
		const bytes = this.crypto.randomBytes(32);
		const key = bytes
			.toString("base64url")
			.replace(/[^a-zA-Z0-9]/g, "")
			.substring(0, 32);
		return `btr-${key}`;
	}

	async hashApiKey(apiKey: string): Promise<string> {
		const salt = this.crypto.randomBytes(16).toString("hex");
		const hashBuf: Buffer = await this.scryptAsync(apiKey, salt, 64);
		const hash = hashBuf.toString("hex");
		return `${salt}:${hash}`;
	}

	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		try {
			const [salt, hash] = hashedKey.split(":");
			if (!salt || !hash) {
				return false;
			}

			const candidateBuf: Buffer = await this.scryptAsync(apiKey, salt, 64);
			const candidateHash = candidateBuf.toString("hex");

			// Length validation before timing-safe comparison
			if (candidateHash.length !== hash.length) {
				return false;
			}

			// Constant-time comparison to prevent timing attacks
			const candidateBuffer = Buffer.from(candidateHash, "utf8");
			const storedBuffer = Buffer.from(hash, "utf8");

			return this.crypto.timingSafeEqual(candidateBuffer, storedBuffer);
		} catch (error) {
			// Log error for debugging but don't expose details to caller
			console.error(
				"API key verification error:",
				error instanceof Error ? error.message : "Unknown error",
			);
			return false;
		}
	}
}

// Converter functions
export function toApiKey(row: ApiKeyRow): ApiKey {
	return {
		limitWindowMode:
			row.limit_window_mode === "rolling" ? "rolling" : "calendar",
		familyComboOverrides: parseFamilyComboOverrides(row.family_combo_overrides),
		id: row.id,
		name: row.name,
		hashedKey: row.hashed_key,
		prefixLast8: row.prefix_last_8,
		createdAt: Number(row.created_at),
		lastUsed: row.last_used != null ? Number(row.last_used) : null,
		usageCount: Number(row.usage_count) || 0,
		isActive: !!row.is_active,
		role: row.role,
		allowedAccounts: parseRestrictionList(row.allowed_accounts),
		allowedModels: parseRestrictionList(row.allowed_models),
		allowedProviders: parseRestrictionList(row.allowed_providers),
		// A limit that is not a usable number reads as "no limit": see
		// toApiKeySpendLimit. The window/enforcement columns are only
		// meaningful alongside a limit, so they stay null without one rather
		// than materialising defaults for a key that has no budget.
		limitUsd: coerceSpendLimitUsd(row.limit_usd),
		limitWindow:
			coerceSpendLimitUsd(row.limit_usd) != null
				? parseSpendWindow(row.limit_window)
				: null,
		limitEnforce:
			coerceSpendLimitUsd(row.limit_usd) != null
				? parseLimitEnforcement(row.limit_enforce)
				: null,
	};
}

export function toApiKeyResponse(apiKey: ApiKey): ApiKeyResponse {
	return {
		limitWindowMode: apiKey.limitWindowMode ?? "calendar",
		familyComboOverrides: apiKey.familyComboOverrides ?? null,
		id: apiKey.id,
		name: apiKey.name,
		prefixLast8: apiKey.prefixLast8,
		createdAt: new Date(apiKey.createdAt).toISOString(),
		lastUsed: apiKey.lastUsed ? new Date(apiKey.lastUsed).toISOString() : null,
		usageCount: apiKey.usageCount,
		isActive: apiKey.isActive,
		role: apiKey.role,
		allowedAccounts: apiKey.allowedAccounts,
		allowedModels: apiKey.allowedModels,
		allowedProviders: apiKey.allowedProviders,
		limitUsd: apiKey.limitUsd,
		limitWindow: apiKey.limitWindow,
		limitEnforce: apiKey.limitEnforce,
	};
}
