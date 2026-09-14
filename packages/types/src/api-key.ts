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

// Database row type that matches actual database schema
export interface ApiKeyRow {
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

// Domain model - used throughout the application
export interface ApiKey {
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
}

// API response type - what clients receive (excluding sensitive data)
export interface ApiKeyResponse {
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
	};
}

export function toApiKeyResponse(apiKey: ApiKey): ApiKeyResponse {
	return {
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
	};
}
