import {
	getAllowedModelsMessage,
	isValidClaudeModel,
} from "@better-ccflare/core";
import type { APIContext } from "@better-ccflare/types";

/**
 * Shared model acceptance check for all agent/config model write endpoints.
 *
 * A model is allowed if it matches the known Claude family pattern
 * (`isValidClaudeModel`) OR if it is an exact id present in a *live*
 * model catalog (a genuinely new family the dashboard sourced its dropdown
 * from). A fallback catalog, a missing catalog, or a catalog read error all
 * fail open to pattern-only matching — this preserves today's behavior when
 * no live data is available, matching the fail-open semantics of the
 * proxy-side `isRewriteTargetServable` veto and the dashboard warning in
 * agents.ts.
 */
export async function isAllowedModel(
	model: string,
	modelCatalog?: APIContext["modelCatalog"],
): Promise<boolean> {
	if (isValidClaudeModel(model)) return true;
	if (!modelCatalog) return false;
	try {
		const catalog = await modelCatalog.get();
		if (catalog.source !== "live") return false;
		return catalog.models.some((entry) => entry.id === model);
	} catch {
		return false;
	}
}

export function allowedModelErrorMessage(): string {
	return `${getAllowedModelsMessage()} — or any model id present in the live Anthropic model catalog.`;
}
