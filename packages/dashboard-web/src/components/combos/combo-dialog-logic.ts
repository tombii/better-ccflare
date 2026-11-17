import type { ApiKeyResponse } from "@better-ccflare/types";

/** Combo name rule shared by create and edit: non-empty, at most 100 chars. */
export function isComboNameValid(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= 100;
}

export interface ComboFormValues {
	name: string;
	description: string;
}

/** Form state seeded from a loaded combo (null description becomes ""). */
export function comboFormValues(combo: {
	name: string;
	description: string | null;
}): ComboFormValues {
	return { name: combo.name, description: combo.description ?? "" };
}

/**
 * True when the form differs from the loaded combo once both sides are
 * trimmed the way the update request sends them.
 */
export function isComboFormDirty(
	form: ComboFormValues,
	combo: { name: string; description: string | null },
): boolean {
	const initial = comboFormValues(combo);
	// Compare exactly what the update request would send, on both sides.
	return (
		form.name.trim() !== initial.name.trim() ||
		(form.description.trim() || undefined) !==
			(initial.description.trim() || undefined)
	);
}

/**
 * True when the form holds no unsaved edits relative to the loaded combo.
 * The inverse of {@link isComboFormDirty}, named for the seeding logic.
 */
export function isComboFormPristine(
	form: ComboFormValues,
	combo: { name: string; description: string | null },
): boolean {
	return !isComboFormDirty(form, combo);
}

/**
 * True when the form should be re-seeded from the loaded combo: the combo
 * changed underneath the form (e.g. a successful save followed by a reopen,
 * or a poll picking up another tab's edit) and the form still holds exactly
 * the previous combo's values, i.e. the user has no unsaved edits to clobber.
 *
 * `previous` is the combo the form was last seeded from; pass null when there
 * is no prior snapshot.
 */
export function shouldReseedComboForm(
	form: ComboFormValues,
	combo: { name: string; description: string | null },
	previous: { name: string; description: string | null } | null,
): boolean {
	if (!previous) return false;
	const current = comboFormValues(combo);
	const prior = comboFormValues(previous);
	const comboChanged =
		current.name !== prior.name || current.description !== prior.description;
	if (!comboChanged) return false;
	// Dirty against the previous combo means the user edited the form since
	// it was seeded; leave those edits alone.
	return !isComboFormDirty(form, previous);
}

const capitalise = (family: string) =>
	family.charAt(0).toUpperCase() + family.slice(1);

/** Labels (capitalised) of every family whose routing points at this combo. */
export function familiesRoutingThroughCombo(
	families: { family: string; combo_id: string | null }[],
	comboId: string,
): string[] {
	return families
		.filter((f) => f.combo_id === comboId)
		.map((f) => capitalise(f.family));
}

/**
 * Human-readable sentence naming every family routed through a combo, e.g.
 * "Opus and Sonnet route through this combo and will fall back to normal pool
 * routing." Returns null when no family routes through it.
 */
export function describeFamiliesRoutingThrough(
	labels: string[],
): string | null {
	if (labels.length === 0) return null;
	const joined =
		labels.length === 1
			? labels[0]
			: `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
	const verb = labels.length === 1 ? "routes" : "route";
	return `${joined} ${verb} through this combo and will fall back to normal pool routing.`;
}

/** Number of API keys whose family overrides point at this combo. */
export function countKeysOverridingCombo(
	keys: ApiKeyResponse[] | undefined,
	comboId: string,
): number {
	if (!keys) return 0;
	return keys.filter((key) =>
		Object.values(key.familyComboOverrides ?? {}).includes(comboId),
	).length;
}
