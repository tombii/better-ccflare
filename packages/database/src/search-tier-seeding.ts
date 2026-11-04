/**
 * Startup seeding for search provider tiers.
 *
 * Free (keyless) tiers are installed once, disabled, as last-resort rows: an
 * operator who turns web-search interception on without any API keys can
 * simply enable them (or flip the dashboard's "use free tier" toggle, which
 * does the same thing in bulk). Seeding runs on every start but only ever
 * CREATES a missing free row — an existing one is never touched, so priority
 * edits, renames and deletions stick.
 *
 * Identity is the row's TIER, not its label: "the free row for keenable" is
 * whichever row has `tier = 'free'` and no key. A renamed free row is found
 * and left alone instead of being duplicated.
 *
 * A paid row for the same provider is unaffected: the free row carries its
 * own label, and `label` is the only unique index, so both coexist at any
 * priority the operator likes.
 */

import {
	SEARCH_PROVIDER_CATALOG,
	type SearchProviderId,
} from "@better-ccflare/types";
import type { SearchProviderRepository } from "./repositories/search-provider.repository";

/** Default display label a free-tier row is created with. */
function defaultFreeLabel(providerLabel: string): string {
	return `${providerLabel} (free)`;
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
		const displayLabel = defaultFreeLabel(entry.label);
		// Look the row up by tier, not label: a renamed free row is still the
		// free row and must not be duplicated. A label collision with some
		// unrelated row is also a reason not to create.
		if (await repository.findFreeTierByProvider(entry.id)) continue;
		if (await repository.isLabelTaken(displayLabel)) continue;
		await repository.create({
			provider: entry.id,
			label: displayLabel,
			apiKey: null,
			priority: entry.freeTierDefault.priority,
			enabled: entry.freeTierDefault.enabled,
			tier: "free",
		});
		created.push(displayLabel);
	}
	return created;
}

/**
 * Enable or disable every FREE row in one step (the "use free tier" toggle).
 *
 * "Actually free" is checked against both facts that decide the endpoint —
 * the row's tier AND the absence of a stored key — so this can never switch a
 * paid (keyed) search on or off. A free row that was given a key is a paid
 * row and is left alone.
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
		if (!isFreeTierRow(row) || row.enabled === enabled) continue;
		await repository.update(row.id, { enabled });
		changed.push(row.id);
	}
	return changed;
}

/**
 * True when a row really serves a keyless endpoint: marked `free`, with no
 * key stored, for a provider that has a keyless path.
 */
export function isFreeTierRow(row: {
	provider: SearchProviderId;
	tier: string;
	apiKey: string | null;
}): boolean {
	if (row.tier !== "free" || row.apiKey) return false;
	const entry = SEARCH_PROVIDER_CATALOG.find((e) => e.id === row.provider);
	return entry !== undefined && entry.requiresKey === false;
}
