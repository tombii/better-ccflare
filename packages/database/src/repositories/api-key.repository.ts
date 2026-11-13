import {
	type ApiKey,
	type ApiKeyLimit,
	type ApiKeyLimitInput,
	type ApiKeyLimitWindowMode,
	type ApiKeyRestrictions,
	type ApiKeyRow,
	type ApiKeySpendLimit,
	serializeRestrictionList,
	toApiKey,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export class ApiKeyRepository extends BaseRepository<ApiKey> {
	/**
	 * Find all API keys, ordered by creation date (newest first)
	 */
	async findAll(): Promise<ApiKey[]> {
		const rows = await this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active, role,
				allowed_accounts, allowed_models, allowed_providers,
				limit_usd, limit_window, limit_enforce, limit_window_mode, family_combo_overrides
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
				last_used, usage_count, is_active, role,
				allowed_accounts, allowed_models, allowed_providers,
				limit_usd, limit_window, limit_enforce, limit_window_mode, family_combo_overrides
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
				last_used, usage_count, is_active, role,
				allowed_accounts, allowed_models, allowed_providers,
				limit_usd, limit_window, limit_enforce, limit_window_mode, family_combo_overrides
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
				last_used, usage_count, is_active, role,
				allowed_accounts, allowed_models, allowed_providers,
				limit_usd, limit_window, limit_enforce, limit_window_mode, family_combo_overrides
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
				last_used, usage_count, is_active, role,
				allowed_accounts, allowed_models, allowed_providers,
				limit_usd, limit_window, limit_enforce, limit_window_mode, family_combo_overrides
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
				last_used, is_active, role,
				allowed_accounts, allowed_models, allowed_providers,
				limit_usd, limit_window, limit_enforce
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
				// `?? null` and not `|| null`: the columns are nullable on
				// purpose and an absent restriction must land as SQL NULL
				// (unrestricted), never as the string '[]' (deny-all).
				apiKey.allowed_accounts ?? null,
				apiKey.allowed_models ?? null,
				apiKey.allowed_providers ?? null,
				// Same `?? null` reasoning: a key created without a limit must
				// land as SQL NULL, not as 0 (which would deny every request).
				apiKey.limit_usd ?? null,
				apiKey.limit_window ?? null,
				apiKey.limit_enforce ?? null,
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
	 * Update the role of an API key
	 */
	async updateRole(id: string, role: "admin" | "api-only"): Promise<boolean> {
		const changes = await this.runWithChanges(
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
	 * Replace an API key's restrictions.
	 *
	 * Writes all three columns in one statement so a partial update can never
	 * leave a key half-restricted: the caller always supplies the complete
	 * intended state, with `null` meaning unrestricted and `[]` meaning
	 * deny-all.
	 */
	async updateRestrictions(
		id: string,
		restrictions: ApiKeyRestrictions,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE api_keys
			SET allowed_accounts = ?,
				allowed_models = ?,
				allowed_providers = ?
			WHERE id = ?
		`,
			[
				serializeRestrictionList(restrictions.allowedAccounts),
				serializeRestrictionList(restrictions.allowedModels),
				serializeRestrictionList(restrictions.allowedProviders),
				id,
			],
		);

		return changes > 0;
	}

	/**
	 * Replace an API key's spend limit.
	 *
	 * `null` clears the limit, and clears the window and enforcement columns
	 * with it: leaving a stale window behind on a key with no budget would
	 * make a later "set a limit of $50" silently inherit a window the operator
	 * set months ago and has no reason to remember.
	 */
	async updateSpendLimit(
		id: string,
		spendLimit: ApiKeySpendLimit | null,
	): Promise<boolean> {
		const key = await this.findById(id);
		if (!key) return false;
		const rows = await this.getLimits(id);
		const oldWindow = key.limitWindow
			? key.limitWindow === "rolling_7d"
				? "week"
				: "month"
			: null;
		const window = spendLimit
			? spendLimit.limitWindow === "rolling_7d"
				? "week"
				: "month"
			: oldWindow;
		const remaining = rows.filter(
			(row) =>
				!(
					row.scopeModel == null &&
					(row.window === oldWindow || row.window === window)
				),
		);
		const currentMode = key.limitWindowMode ?? "calendar";
		const mode = spendLimit
			? spendLimit.limitWindow === "calendar_month"
				? "calendar"
				: "rolling"
			: currentMode;
		if (mode !== currentMode && remaining.length > 0) {
			throw Object.assign(
				new Error(
					"Legacy spend limit cannot change the window mode while other limits exist; use PUT /api/api-keys/:id/limits",
				),
				{ statusCode: 409 },
			);
		}
		const now = Date.now();
		const existing = rows.find(
			(row) => row.scopeModel == null && row.window === window,
		);
		const statements = [
			{
				sql: "UPDATE api_keys SET limit_usd = ?, limit_window = ?, limit_enforce = ?, limit_window_mode = ? WHERE id = ?",
				params: [
					spendLimit?.limitUsd ?? null,
					spendLimit?.limitWindow ?? null,
					spendLimit?.limitEnforce ?? null,
					mode,
					id,
				] as unknown[],
			},
		];
		for (const row of rows) {
			if (
				row.scopeModel == null &&
				(row.window === oldWindow || row.window === window)
			) {
				statements.push({
					sql: "DELETE FROM api_key_limits WHERE id = ?",
					params: [row.id],
				});
			}
		}
		if (spendLimit)
			statements.push({
				sql: 'INSERT INTO api_key_limits (id, api_key_id, scope_model, "window", limit_usd, enforce, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				params: [
					existing?.id ?? crypto.randomUUID(),
					id,
					null,
					window,
					spendLimit.limitUsd,
					spendLimit.limitEnforce,
					existing?.createdAt ?? now,
					now,
				],
			});
		await this.adapter.atomicStatements(statements);
		return true;
	}

	/**
	 * Every ACTIVE key that carries a spend limit.
	 *
	 * The seed set for the in-memory spend counter at startup: a key with no
	 * limit needs no counter at all, and an inactive key cannot make a request
	 * to spend against one.
	 */
	async listWithSpendLimits(): Promise<ApiKey[]> {
		const rows = await this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active, role,
				allowed_accounts, allowed_models, allowed_providers,
				limit_usd, limit_window, limit_enforce, limit_window_mode, family_combo_overrides
			FROM api_keys
			WHERE is_active = 1 AND EXISTS (SELECT 1 FROM api_key_limits WHERE api_key_id = api_keys.id)
			ORDER BY created_at DESC
		`);

		return rows.map(toApiKey);
	}

	async getLimits(apiKeyId: string): Promise<ApiKeyLimit[]> {
		const rows = await this.query<{
			id: string;
			api_key_id: string;
			scope_model: string | null;
			window: ApiKeyLimit["window"];
			limit_usd: number;
			enforce: ApiKeyLimit["enforce"];
			created_at: number;
			updated_at: number;
		}>(
			"SELECT * FROM api_key_limits WHERE api_key_id = ? ORDER BY created_at, id",
			[apiKeyId],
		);
		return rows.map((row) => ({
			id: row.id,
			apiKeyId: row.api_key_id,
			scopeModel: row.scope_model,
			window: row.window,
			limitUsd: Number(row.limit_usd),
			enforce: row.enforce,
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
		}));
	}
	async replaceLimits(
		apiKeyId: string,
		limits: ApiKeyLimitInput[],
		mode: ApiKeyLimitWindowMode,
	): Promise<boolean> {
		const key = await this.findById(apiKeyId);
		if (!key) return false;
		const legacyWindow = key.limitWindow === "rolling_7d" ? "week" : "month";
		const legacyMode =
			key.limitWindow === "calendar_month" ? "calendar" : "rolling";
		const legacy =
			key.limitWindow && mode === legacyMode
				? limits.find(
						(row) => row.scopeModel == null && row.window === legacyWindow,
					)
				: undefined;
		const existing = await this.getLimits(apiKeyId);
		const now = Date.now();
		const statements = [
			{
				sql: "UPDATE api_keys SET limit_window_mode = ?, limit_usd = ?, limit_window = ?, limit_enforce = ? WHERE id = ?",
				params: [
					mode,
					legacy?.limitUsd ?? null,
					legacy ? key.limitWindow : null,
					legacy?.enforce ?? null,
					apiKeyId,
				] as unknown[],
			},
			{
				sql: "DELETE FROM api_key_limits WHERE api_key_id = ?",
				params: [apiKeyId] as unknown[],
			},
			...limits.map((limit) => {
				const previous = existing.find(
					(row) =>
						row.scopeModel === limit.scopeModel && row.window === limit.window,
				);
				return {
					sql: 'INSERT INTO api_key_limits (id, api_key_id, scope_model, "window", limit_usd, enforce, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
					params: [
						previous?.id ?? crypto.randomUUID(),
						apiKeyId,
						limit.scopeModel,
						limit.window,
						limit.limitUsd,
						limit.enforce,
						previous?.createdAt ?? now,
						now,
					] as unknown[],
				};
			}),
		];
		await this.adapter.atomicStatements(statements);
		return true;
	}
	async updateRouting(
		apiKeyId: string,
		overrides: Record<string, string> | null,
	): Promise<boolean> {
		return (
			(await this.runWithChanges(
				"UPDATE api_keys SET family_combo_overrides = ? WHERE id = ?",
				[overrides == null ? null : JSON.stringify(overrides), apiKeyId],
			)) > 0
		);
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

		// Bun.SQL returns COUNT(*) on PostgreSQL as a JavaScript string
		// (BIGINT is stringified, see Bun#22188). Coerce to Number so the
		// public return type stays a plain number and downstream `toBe(N)`
		// assertions hold on both dialects.
		return Number(row?.count) || 0;
	}

	/**
	 * Count the total number of API keys (active and inactive)
	 */
	async countAll(): Promise<number> {
		const row = await this.get<{ count: number }>(`
			SELECT COUNT(*) as count
			FROM api_keys
		`);

		// See countActive() for the Bun.SQL BIGINT-as-string caveat.
		return Number(row?.count) || 0;
	}

	/**
	 * Clear all API keys (for testing purposes)
	 */
	async clearAll(): Promise<void> {
		await this.run("DELETE FROM api_keys");
	}
}
