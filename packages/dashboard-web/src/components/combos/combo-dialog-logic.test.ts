import { describe, expect, it } from "bun:test";
import type { ApiKeyResponse } from "@better-ccflare/types";
import {
	comboFormValues,
	countKeysOverridingCombo,
	isComboFormDirty,
	isComboNameValid,
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
