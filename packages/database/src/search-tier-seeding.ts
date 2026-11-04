/**
 * Startup seeding for search provider tiers.
 *
 * Free (keyless) tiers are installed once, disabled, as last-resort rows: an
 * operator who turns web-search interception on without any API keys can
 * simply enable them (or flip the dashboard's "use free tier" toggle, which
 * does the same thing in bulk). Seeding runs on every start but is
 * upsert-by-label and only ever CREATES the free row — a row that already
 * exists is never touched, so priority edits, renames and deletions stick.
 *
 * A paid row for the same provider is unaffected: `search_providers.label` is
 * unique, and the free rows carry their own label, so both can coexist at any
 * priority the operator likes.
 */

import {
	SEARCH_PROVIDER_CATALOG,
	type SearchProviderId,
} from "@better-ccflare/types";
import type { SearchProviderRepository } from "./repositories/search-provider.repository";

/** Label of the seeded free-tier row for a provider (also its identity). */
export function freeTierLabel(id: SearchProviderId): string {
	return `${id}-free`;
}

/**
 * Create any missing free-tier rows, disabled and at last-resort priority.
 * Safe to call on every startup and on every backend.
 *
 * @returns the display labels actually created (empty when all were present).
 */
export async function seedFreeSearchProviders(
	repository: SearchProviderRepository,
): Promise<string[]> {
	const created: string[] = [];
	for (const entry of SEARCH_PROVIDER_CATALOG) {
		if (!entry.keyless || !entry.freeTierDefault) continue;
		const displayLabel = `${entry.label} (free)`;
		if (await repository.isLabelTaken(displayLabel)) continue;
		await repository.create({
			provider: entry.id,
			label: displayLabel,
			apiKey: null,
			priority: entry.freeTierDefault.priority,
			enabled: entry.freeTierDefault.enabled,
			freeTier: true,
		});
		created.push(displayLabel);
	}
	return created;
}

/**
 * Enable or disable every free-tier row in one step (the "use free tier"
 * toggle). Keyed rows are never touched.
 *
 * @returns ids of the rows whose `enabled` value changed.
 */
export async function setFreeSearchTiersEnabled(
	repository: SearchProviderRepository,
	enabled: boolean,
): Promise<string[]> {
	const rows = await repository.findAll();
	const changed: string[] = [];
	for (const row of rows) {
		if (!row.freeTier || row.enabled === enabled) continue;
		await repository.update(row.id, { enabled, freeTier: true });
		changed.push(row.id);
	}
	return changed;
}
