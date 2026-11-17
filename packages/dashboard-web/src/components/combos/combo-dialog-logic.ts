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
