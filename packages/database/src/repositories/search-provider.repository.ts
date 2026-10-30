import { randomUUID } from "node:crypto";
import {
	maskApiKey,
	type SearchProvider,
	type SearchProviderId,
	type SearchProviderInput,
	type SearchProviderPublic,
	type SearchProviderRow,
	type SearchProviderUpdate,
	toSearchProvider,
	toSearchProviderPublic,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export const DEFAULT_SEARCH_MAX_RESULTS = 10;

/**
 * Raised when a create/update would collide with an existing label. Callers
 * map this to a 409-class error instead of letting a raw driver constraint
 * exception escape.
 */
export class SearchProviderLabelTakenError extends Error {
	readonly code = "SEARCH_PROVIDER_LABEL_TAKEN";

	constructor(readonly label: string) {
		super(`A search provider labelled "${label}" already exists`);
		this.name = "SearchProviderLabelTakenError";
	}
}

/** Raised when {@link SearchProviderRepository.update} matches no row. */
export class SearchProviderNotFoundError extends Error {
	readonly code = "SEARCH_PROVIDER_NOT_FOUND";

	constructor(readonly id: string) {
		super(`Search provider not found: ${id}`);
		this.name = "SearchProviderNotFoundError";
	}
}

/** True for a UNIQUE/PK constraint violation on either backend. */
function isUniqueViolation(error: unknown): boolean {
	const err = error as { code?: string; errno?: number; message?: string };
	// PostgreSQL SQLSTATE 23505; SQLite constraint code (SQLITE_CONSTRAINT*
	// covers UNIQUE too — notFound is guarded by an explicit pre-read).
	if (err?.code === "23505") return true;
	const msg = err?.message ?? "";
	return (
		/UNIQUE constraint failed/i.test(msg) ||
		/duplicate key value violates unique constraint/i.test(msg)
	);
}

const SELECT_COLUMNS = `
	id, provider, label, api_key, priority, enabled, max_results, extra_config,
	status, status_message, status_checked_at, cooldown_until, created_at, updated_at`;

/**
 * Repository for the `search_providers` table.
 *
 * Every method returns the full {@link SearchProvider} (plaintext key) so the
 * proxy can call the upstream API. Anything exposed over HTTP must go through
 * {@link toPublic} (or the `*Public` variants) which mask the key.
 */
export class SearchProviderRepository extends BaseRepository<SearchProvider> {
	// ── Reads ────────────────────────────────────────────────────────────────

	/** All providers, ordered by priority ASC (then label for determinism). */
	async findAll(): Promise<SearchProvider[]> {
		const rows = await this.query<SearchProviderRow>(
			`SELECT ${SELECT_COLUMNS} FROM search_providers
			 ORDER BY priority ASC, label ASC`,
		);
		return rows.map(toSearchProvider);
	}

	/**
	 * Enabled providers only, ordered by priority ASC — the routing order the
	 * proxy walks when picking a search backend.
	 */
	async listActiveByPriority(): Promise<SearchProvider[]> {
		const rows = await this.query<SearchProviderRow>(
			`SELECT ${SELECT_COLUMNS} FROM search_providers
			 WHERE enabled = 1
			 ORDER BY priority ASC, label ASC`,
		);
		return rows.map(toSearchProvider);
	}

	async findById(id: string): Promise<SearchProvider | null> {
		const row = await this.get<SearchProviderRow>(
			`SELECT ${SELECT_COLUMNS} FROM search_providers WHERE id = ?`,
			[id],
		);
		return row ? toSearchProvider(row) : null;
	}

	async isLabelTaken(label: string, exceptId?: string): Promise<boolean> {
		const row = exceptId
			? await this.get<{ id: string }>(
					`SELECT id FROM search_providers WHERE label = ? AND id != ?`,
					[label, exceptId],
				)
			: await this.get<{ id: string }>(
					`SELECT id FROM search_providers WHERE label = ?`,
					[label],
				);
		return row !== null;
	}

	// ── Writes ───────────────────────────────────────────────────────────────

	async create(input: SearchProviderInput): Promise<SearchProvider> {
		if (await this.isLabelTaken(input.label)) {
			throw new SearchProviderLabelTakenError(input.label);
		}
		const id = randomUUID();
		const now = Date.now();
		try {
			await this.run(
				`INSERT INTO search_providers (
					id, provider, label, api_key, priority, enabled, max_results,
					extra_config, status, status_message, status_checked_at,
					cooldown_until, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, NULL, ?, ?)`,
				[
					id,
					input.provider,
					input.label,
					input.apiKey ?? null,
					input.priority ?? 0,
					input.enabled === false ? 0 : 1,
					input.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
					input.extraConfig ? JSON.stringify(input.extraConfig) : null,
					now,
					now,
				],
			);
		} catch (error) {
			// A concurrent create can slip past the pre-check above; the unique
			// index is the real guard, so translate its violation too.
			if (isUniqueViolation(error)) {
				throw new SearchProviderLabelTakenError(input.label);
			}
			throw error;
		}
		const created = await this.findById(id);
		if (!created) throw new Error(`Failed to create search provider: ${id}`);
		return created;
	}

	/**
	 * Apply a partial update; `updated_at` always moves. `apiKey` omitted
	 * keeps the stored key, `apiKey: null` clears it.
	 */
	async update(
		id: string,
		fields: SearchProviderUpdate,
	): Promise<SearchProvider> {
		const existing = await this.findById(id);
		if (!existing) throw new SearchProviderNotFoundError(id);

		if (fields.label !== undefined && fields.label !== existing.label) {
			if (await this.isLabelTaken(fields.label, id)) {
				throw new SearchProviderLabelTakenError(fields.label);
			}
		}

		const setClauses: string[] = ["updated_at = ?"];
		const params: unknown[] = [Date.now()];

		if (fields.provider !== undefined) {
			setClauses.push("provider = ?");
			params.push(fields.provider);
		}
		if (fields.label !== undefined) {
			setClauses.push("label = ?");
			params.push(fields.label);
		}
		if (Object.hasOwn(fields, "apiKey")) {
			setClauses.push("api_key = ?");
			params.push(fields.apiKey ?? null);
		}
		if (fields.priority !== undefined) {
			setClauses.push("priority = ?");
			params.push(fields.priority);
		}
		if (fields.enabled !== undefined) {
			setClauses.push("enabled = ?");
			params.push(fields.enabled ? 1 : 0);
		}
		if (fields.maxResults !== undefined) {
			setClauses.push("max_results = ?");
			params.push(fields.maxResults);
		}
		if (Object.hasOwn(fields, "extraConfig")) {
			setClauses.push("extra_config = ?");
			params.push(
				fields.extraConfig ? JSON.stringify(fields.extraConfig) : null,
			);
		}

		params.push(id);
		try {
			await this.run(
				`UPDATE search_providers SET ${setClauses.join(", ")} WHERE id = ?`,
				params,
			);
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new SearchProviderLabelTakenError(fields.label ?? existing.label);
			}
			throw error;
		}

		const updated = await this.findById(id);
		if (!updated) throw new SearchProviderNotFoundError(id);
		return updated;
	}

	/**
	 * Record the outcome of a health probe. Deliberately does NOT touch
	 * `updated_at` — a probe is not an operator edit.
	 */
	async updateHealth(
		id: string,
		health: {
			status: string;
			statusMessage?: string | null;
			cooldownUntil?: number | null;
			checkedAt?: number;
		},
	): Promise<void> {
		await this.run(
			`UPDATE search_providers
			 SET status = ?, status_message = ?, status_checked_at = ?, cooldown_until = ?
			 WHERE id = ?`,
			[
				health.status,
				health.statusMessage ?? null,
				health.checkedAt ?? Date.now(),
				health.cooldownUntil ?? null,
				id,
			],
		);
	}

	/** Hard delete — nothing references `search_providers.id`. */
	async delete(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`DELETE FROM search_providers WHERE id = ?`,
			[id],
		);
		return changes > 0;
	}

	// ── API-facing helpers (masked key) ──────────────────────────────────────

	async findAllPublic(): Promise<SearchProviderPublic[]> {
		return (await this.findAll()).map(toSearchProviderPublic);
	}

	async findByIdPublic(id: string): Promise<SearchProviderPublic | null> {
		const provider = await this.findById(id);
		return provider ? toSearchProviderPublic(provider) : null;
	}
}

export type { SearchProviderId };
export { maskApiKey, toSearchProviderPublic };
