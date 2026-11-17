import { describe, expect, it } from "bun:test";
import type { ApiKeyResponse } from "@better-ccflare/types";
import {
	comboFormValues,
	countKeysOverridingCombo,
	describeFamiliesRoutingThrough,
	familiesRoutingThroughCombo,
	isComboFormDirty,
	isComboFormPristine,
	isComboNameValid,
	shouldReseedComboForm,
} from "./combo-dialog-logic";

const combo = { name: "My Combo", description: "primary chain" };

describe("isComboNameValid", () => {
	it("rejects empty and whitespace-only names", () => {
		expect(isComboNameValid("")).toBe(false);
		expect(isComboNameValid("   ")).toBe(false);
	});

	it("accepts names up to 100 trimmed characters", () => {
		expect(isComboNameValid("a")).toBe(true);
		expect(isComboNameValid("a".repeat(100))).toBe(true);
		expect(isComboNameValid("a".repeat(101))).toBe(false);
	});
});

describe("comboFormValues", () => {
	it("seeds the edit form from the loaded combo", () => {
		expect(comboFormValues(combo)).toEqual({
			name: "My Combo",
			description: "primary chain",
		});
	});

	it("maps a null description to an empty string", () => {
		expect(comboFormValues({ name: "X", description: null }).description).toBe(
			"",
		);
	});
});

describe("isComboFormDirty", () => {
	it("is false for the untouched seeded form", () => {
		expect(isComboFormDirty(comboFormValues(combo), combo)).toBe(false);
	});

	it("ignores surrounding whitespace and an empty description", () => {
		expect(
			isComboFormDirty(
				{ name: " My Combo ", description: " primary chain " },
				combo,
			),
		).toBe(false);
		expect(
			isComboFormDirty(
				{ name: "X", description: "" },
				{ name: "X", description: null },
			),
		).toBe(false);
	});

	it("detects a renamed combo or an edited description", () => {
		expect(isComboFormDirty({ ...combo, name: "Renamed" }, combo)).toBe(true);
		expect(isComboFormDirty({ ...combo, description: "new" }, combo)).toBe(
			true,
		);
	});

	it("treats clearing an existing description as dirty", () => {
		expect(isComboFormDirty({ name: "My Combo", description: "" }, combo)).toBe(
			true,
		);
		// Whitespace-only is the same as cleared.
		expect(
			isComboFormDirty({ name: "My Combo", description: "   " }, combo),
		).toBe(true);
	});
});

describe("isComboFormPristine", () => {
	it("is the inverse of isComboFormDirty", () => {
		expect(isComboFormPristine(comboFormValues(combo), combo)).toBe(true);
		expect(isComboFormPristine({ ...combo, name: "X" }, combo)).toBe(false);
	});
});

describe("shouldReseedComboForm", () => {
	it("does not re-seed when the combo has not changed", () => {
		expect(shouldReseedComboForm(comboFormValues(combo), combo, combo)).toBe(
			false,
		);
	});

	it("does not re-seed without a prior snapshot", () => {
		expect(shouldReseedComboForm(comboFormValues(combo), combo, null)).toBe(
			false,
		);
	});

	it("re-seeds an untouched form when the combo's name changed", () => {
		expect(
			shouldReseedComboForm(
				comboFormValues(combo),
				{ ...combo, name: "Renamed" },
				combo,
			),
		).toBe(true);
	});

	it("re-seeds an untouched form when the combo's description changed", () => {
		expect(
			shouldReseedComboForm(
				comboFormValues(combo),
				{ ...combo, description: null },
				combo,
			),
		).toBe(true);
	});

	it("never clobbers in-progress edits", () => {
		expect(
			shouldReseedComboForm(
				{ name: "Typing...", description: "primary chain" },
				{ ...combo, name: "Renamed" },
				combo,
			),
		).toBe(false);
		// Clearing the description is an edit too.
		expect(
			shouldReseedComboForm(
				{ name: "My Combo", description: "" },
				{ ...combo, name: "Renamed" },
				combo,
			),
		).toBe(false);
	});
});

describe("familiesRoutingThroughCombo", () => {
	const families = [
		{ family: "opus", combo_id: "combo-a" },
		{ family: "sonnet", combo_id: "combo-a" },
		{ family: "haiku", combo_id: "combo-b" },
		{ family: "fable", combo_id: null },
	];

	it("returns every matching family, capitalised", () => {
		expect(familiesRoutingThroughCombo(families, "combo-a")).toEqual([
			"Opus",
			"Sonnet",
		]);
		expect(familiesRoutingThroughCombo(families, "combo-b")).toEqual(["Haiku"]);
	});

	it("returns an empty list when nothing routes through the combo", () => {
		expect(familiesRoutingThroughCombo(families, "combo-z")).toEqual([]);
	});
});

describe("describeFamiliesRoutingThrough", () => {
	it("returns null for no families", () => {
		expect(describeFamiliesRoutingThrough([])).toBeNull();
	});

	it("uses the singular verb for one family", () => {
		expect(describeFamiliesRoutingThrough(["Opus"])).toBe(
			"Opus routes through this combo and will fall back to normal pool routing.",
		);
	});

	it("joins two families with 'and'", () => {
		expect(describeFamiliesRoutingThrough(["Opus", "Sonnet"])).toBe(
			"Opus and Sonnet route through this combo and will fall back to normal pool routing.",
		);
	});

	it("joins three families with commas and 'and'", () => {
		expect(describeFamiliesRoutingThrough(["Opus", "Sonnet", "Haiku"])).toBe(
			"Opus, Sonnet and Haiku route through this combo and will fall back to normal pool routing.",
		);
	});
});

describe("countKeysOverridingCombo", () => {
	const key = (familyComboOverrides: Record<string, string> | null) =>
		({ familyComboOverrides }) as ApiKeyResponse;

	it("counts keys whose overrides point at the combo", () => {
		const keys = [
			key({ opus: "combo-a", sonnet: "combo-b" }),
			key({ haiku: "combo-a" }),
			key({ opus: "combo-b" }),
			key(null),
		];
		expect(countKeysOverridingCombo(keys, "combo-a")).toBe(2);
		expect(countKeysOverridingCombo(keys, "combo-b")).toBe(2);
	});

	it("returns 0 when the key list is not loaded", () => {
		expect(countKeysOverridingCombo(undefined, "combo-a")).toBe(0);
	});
});
