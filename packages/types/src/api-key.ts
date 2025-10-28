// Crypto interface for dependency injection

// Database row type that matches actual database schema
export interface ApiKeyRow {
	id: string;
	name: string;
	hashed_key: string;
	prefix_last_8: string;
	created_at: number;
	last_used: number | null;
	usage_count: number;
	is_active: 0 | 1;
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
}

// API key generation result
export interface ApiKeyGenerationResult {
	id: string;
	name: string;
	apiKey: string; // Full API key (shown only once)
	prefixLast8: string;
	createdAt: string;
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

	constructor() {
		// Import crypto dynamically to avoid issues with bundling
		this.crypto = require("node:crypto");
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
		const hash = this.crypto.scryptSync(apiKey, salt, 64).toString("hex");
		return `${salt}:${hash}`;
	}

	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		try {
			const [salt, hash] = hashedKey.split(":");
			if (!salt || !hash) {
				return false;
			}

			const candidateHash = this.crypto
				.scryptSync(apiKey, salt, 64)
				.toString("hex");

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
		createdAt: row.created_at,
		lastUsed: row.last_used,
		usageCount: row.usage_count,
		isActive: row.is_active === 1,
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
	};
}
