import { type ApiKey, type ApiKeyRow, toApiKey } from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export class ApiKeyRepository extends BaseRepository<ApiKey> {
	/**
	 * Find all API keys, ordered by creation date (newest first)
	 */
	async findAll(): Promise<ApiKey[]> {
		const rows = await this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active
			FROM api_keys
			ORDER BY created_at DESC
		`);
		return rows.map(toApiKey);
	}

	/**
	 * Find only active API keys
	 */
	async findActive(): Promise<ApiKey[]> {
		const rows = await this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active
			FROM api_keys
			WHERE is_active = 1
			ORDER BY created_at DESC
		`);
		return rows.map(toApiKey);
	}

	/**
	 * Find API key by ID
	 */
	async findById(id: string): Promise<ApiKey | null> {
		const row = await this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active
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
	async findByHashedKey(hashedKey: string): Promise<ApiKey | null> {
		const row = await this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active
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
	async findByName(name: string): Promise<ApiKey | null> {
		const row = await this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active
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
	async nameExists(name: string): Promise<boolean> {
		const row = await this.get<{ count: number }>(
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
	async create(apiKey: Omit<ApiKeyRow, "usage_count">): Promise<void> {
		await this.run(
			`
			INSERT INTO api_keys (
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, is_active
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
			[
				apiKey.id,
				apiKey.name,
				apiKey.hashed_key,
				apiKey.prefix_last_8,
				apiKey.created_at,
				apiKey.last_used,
				apiKey.is_active,
			],
		);
	}

	/**
	 * Update the last used timestamp and increment usage count
	 */
	async updateUsage(id: string, timestamp: number): Promise<void> {
		await this.run(
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
	async disable(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
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
	async enable(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
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
	async delete(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			DELETE FROM api_keys
			WHERE id = ?
		`,
			[id],
		);

		return changes > 0;
	}

	/**
	 * Count the number of active API keys
	 */
	async countActive(): Promise<number> {
		const row = await this.get<{ count: number }>(`
			SELECT COUNT(*) as count
			FROM api_keys
			WHERE is_active = 1
		`);

		return row?.count || 0;
	}

	/**
	 * Count the total number of API keys (active and inactive)
	 */
	async countAll(): Promise<number> {
		const row = await this.get<{ count: number }>(`
			SELECT COUNT(*) as count
			FROM api_keys
		`);

		return row?.count || 0;
	}

	/**
	 * Clear all API keys (for testing purposes)
	 */
	async clearAll(): Promise<void> {
		await this.run("DELETE FROM api_keys");
	}
}
