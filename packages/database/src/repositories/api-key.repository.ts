import { type ApiKey, type ApiKeyRow, toApiKey } from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export class ApiKeyRepository extends BaseRepository<ApiKey> {
	/**
	 * Find all API keys, ordered by creation date (newest first)
	 */
	findAll(): ApiKey[] {
		const rows = this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active, role
			FROM api_keys
			ORDER BY created_at DESC
		`);
		return rows.map(toApiKey);
	}

	/**
	 * Find only active API keys
	 */
	findActive(): ApiKey[] {
		const rows = this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active, role
			FROM api_keys
			WHERE is_active = 1
			ORDER BY created_at DESC
		`);
		return rows.map(toApiKey);
	}

	/**
	 * Find API key by ID
	 */
	findById(id: string): ApiKey | null {
		const row = this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active, role
			FROM api_keys
			WHERE id = ?
		`,
			[id],
		);

		return row ? toApiKey(row) : null;
	}

	/**
	 * Find API key by hashed key (for authentication)
	 */
	findByHashedKey(hashedKey: string): ApiKey | null {
		const row = this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active, role
			FROM api_keys
			WHERE hashed_key = ? AND is_active = 1
		`,
			[hashedKey],
		);

		return row ? toApiKey(row) : null;
	}

	/**
	 * Find API key by name
	 */
	findByName(name: string): ApiKey | null {
		const row = this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active, role
			FROM api_keys
			WHERE name = ?
		`,
			[name],
		);

		return row ? toApiKey(row) : null;
	}

	/**
	 * Check if an API key name already exists
	 */
	nameExists(name: string): boolean {
		const row = this.get<{ count: number }>(
			`
			SELECT COUNT(*) as count
			FROM api_keys
			WHERE name = ?
		`,
			[name],
		);

		return row ? row.count > 0 : false;
	}

	/**
	 * Create a new API key
	 */
	create(apiKey: Omit<ApiKeyRow, "usage_count">): void {
		this.run(
			`
			INSERT INTO api_keys (
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, is_active, role
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
			[
				apiKey.id,
				apiKey.name,
				apiKey.hashed_key,
				apiKey.prefix_last_8,
				apiKey.created_at,
				apiKey.last_used,
				apiKey.is_active,
				apiKey.role,
			],
		);
	}

	/**
	 * Update the last used timestamp and increment usage count
	 */
	updateUsage(id: string, timestamp: number): void {
		this.run(
			`
			UPDATE api_keys
			SET last_used = ?,
				usage_count = usage_count + 1
			WHERE id = ?
		`,
			[timestamp, id],
		);
	}

	/**
	 * Disable (soft delete) an API key
	 */
	disable(id: string): boolean {
		const changes = this.runWithChanges(
			`
			UPDATE api_keys
			SET is_active = 0
			WHERE id = ?
		`,
			[id],
		);

		return changes > 0;
	}

	/**
	 * Enable (reactivate) a disabled API key
	 */
	enable(id: string): boolean {
		const changes = this.runWithChanges(
			`
			UPDATE api_keys
			SET is_active = 1
			WHERE id = ?
		`,
			[id],
		);

		return changes > 0;
	}

	/**
	 * Permanently delete an API key
	 */
	delete(id: string): boolean {
		const changes = this.runWithChanges(
			`
			DELETE FROM api_keys
			WHERE id = ?
		`,
			[id],
		);

		return changes > 0;
	}

	/**
	 * Update the role of an API key
	 */
	updateRole(id: string, role: "admin" | "api-only"): boolean {
		const changes = this.runWithChanges(
			`
			UPDATE api_keys
			SET role = ?
			WHERE id = ?
		`,
			[role, id],
		);

		return changes > 0;
	}

	/**
	 * Count the number of active API keys
	 */
	countActive(): number {
		const row = this.get<{ count: number }>(`
			SELECT COUNT(*) as count
			FROM api_keys
			WHERE is_active = 1
		`);

		return row?.count || 0;
	}

	/**
	 * Count the total number of API keys (active and inactive)
	 */
	countAll(): number {
		const row = this.get<{ count: number }>(`
			SELECT COUNT(*) as count
			FROM api_keys
		`);

		return row?.count || 0;
	}

	/**
	 * Clear all API keys (for testing purposes)
	 */
	clearAll(): void {
		this.run("DELETE FROM api_keys");
	}
}
