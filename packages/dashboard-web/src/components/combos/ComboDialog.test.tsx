import { describe, expect, it, spyOn } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import * as ReactQuery from "@tanstack/react-query";
import * as React from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ComboDialog } from "./ComboDialog";

type Element = React.ReactElement<Record<string, unknown>>;

function elements(node: React.ReactNode): Element[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
	return [node as Element, ...elements(node.props.children)];
}

const combo = {
	id: "combo-1",
	name: "My Combo",
	description: "primary chain",
	enabled: true,
	created_at: 0,
	updated_at: 0,
	slots: [],
};

/**
 * Renders ComboDialog by walking its element tree (no DOM), keeping useState
 * values across calls so re-renders after input changes are observable.
 */
function setup(overrides: { name?: string; description?: string | null } = {}) {
	// Mutable so a test can simulate the combo query returning fresh data.
	const data: {
		combo: Omit<typeof combo, "description"> & { description: string | null };
	} = { combo: { ...combo, ...overrides } };
	const states: unknown[] = [];
	let cursor = 0;
	const state = spyOn(React, "useState").mockImplementation(((
		initial: unknown,
	) => {
		const index = cursor++;
		if (!(index in states))
			states[index] = typeof initial === "function" ? initial() : initial;
		return [
			states[index],
			(next: unknown) => {
				states[index] = typeof next === "function" ? next(states[index]) : next;
			},
		];
	}) as typeof React.useState);
	const refs: { current: unknown }[] = [];
	const useRef = spyOn(React, "useRef").mockImplementation(((
		initial: unknown,
	) => {
		const index = cursor++;
		if (!(index in refs)) refs[index] = { current: initial };
		return refs[index];
	}) as typeof React.useRef);
	// Run effects immediately; the seed effect guards itself with a ref.
	const effect = spyOn(React, "useEffect").mockImplementation(((
		fn: () => void,
	) => fn()) as typeof React.useEffect);
	const client = { clear: () => {} } as unknown as QueryClient;
	const queryClient = spyOn(ReactQuery, "useQueryClient").mockReturnValue(
		client,
	);
	const query = spyOn(ReactQuery, "useQuery").mockImplementation((() => ({
		data,
		isLoading: false,
		isError: false,
	})) as never);
	const mutations: Record<string, unknown>[] = [];
	const mutation = spyOn(ReactQuery, "useMutation").mockImplementation((() => {
		const entry: Record<string, unknown> = {
			mutate: (vars: unknown) => {
				entry.vars = vars;
			},
			vars: undefined,
			isPending: false,
			isError: false,
			reset: () => {},
		};
		mutations.push(entry);
		return entry;
	}) as never);
	function render() {
		cursor = 0;
		return elements(
			ComboDialog({ isOpen: true, onClose: () => {}, comboId: combo.id }),
		);
	}
	function restore() {
		for (const spy of [state, useRef, effect, queryClient, query, mutation])
			spy.mockRestore();
	}
	return { render, restore, data, mutations };
}

describe("ComboDialog edit mode", () => {
	it("seeds the name and description from the loaded combo", () => {
		const { render, restore } = setup();
		try {
			// First render mounts, the seed effect sets state, the second
			// render observes the seeded values (as React would re-render).
			render();
			const tree = render();
			const nameInput = tree.find(
				(node) => node.type === Input && node.props.id === "combo-edit-name",
			);
			const descriptionInput = tree.find(
				(node) =>
					node.type === Input && node.props.id === "combo-edit-description",
			);
			expect(nameInput?.props.value).toBe("My Combo");
			expect(descriptionInput?.props.value).toBe("primary chain");
		} finally {
			restore();
		}
	});

	it("seeds an empty description when the combo has none", () => {
		const { render, restore } = setup({ description: null });
		try {
			render();
			const descriptionInput = render().find(
				(node) =>
					node.type === Input && node.props.id === "combo-edit-description",
			);
			expect(descriptionInput?.props.value).toBe("");
		} finally {
			restore();
		}
	});

	it("disables Save Changes until the name is changed and non-empty", () => {
		const { render, restore } = setup();
		try {
			const saveButton = () =>
				render().find(
					(node) =>
						node.type === Button && node.props.children === "Save Changes",
				);
			// Seeded form is unchanged, so there is nothing to save.
			expect(saveButton()?.props.disabled).toBe(true);

			const rename = (value: string) => {
				const input = render().find(
					(node) => node.type === Input && node.props.id === "combo-edit-name",
				);
				(input?.props.onChange as (e: { target: { value: string } }) => void)({
					target: { value },
				});
			};

			rename("Renamed");
			expect(saveButton()?.props.disabled).toBe(false);

			rename("   ");
			expect(saveButton()?.props.disabled).toBe(true);
		} finally {
			restore();
		}
	});

	it("re-seeds a pristine form when the loaded combo changes underneath it", () => {
		const { render, restore, data } = setup();
		try {
			render();
			render();
			// The detail query refetches (e.g. after a save elsewhere) with a
			// new name; the untouched form must follow it.
			data.combo = { ...combo, name: "Renamed" };
			render();
			const nameInput = render().find(
				(node) => node.type === Input && node.props.id === "combo-edit-name",
			);
			expect(nameInput?.props.value).toBe("Renamed");
		} finally {
			restore();
		}
	});

	it("never clobbers in-progress edits when the combo refetches", () => {
		const { render, restore, data } = setup();
		try {
			render();
			render();
			const change = (value: string) => {
				const input = render().find(
					(node) => node.type === Input && node.props.id === "combo-edit-name",
				);
				(input?.props.onChange as (e: { target: { value: string } }) => void)({
					target: { value },
				});
			};
			change("My edit");
			data.combo = { ...combo, name: "Renamed" };
			const nameInput = render().find(
				(node) => node.type === Input && node.props.id === "combo-edit-name",
			);
			expect(nameInput?.props.value).toBe("My edit");
		} finally {
			restore();
		}
	});

	it("sends an explicit empty description when the description is cleared", () => {
		const { render, restore, mutations } = setup();
		try {
			render();
			render();
			const clear = () => {
				const input = render().find(
					(node) =>
						node.type === Input && node.props.id === "combo-edit-description",
				);
				(input?.props.onChange as (e: { target: { value: string } }) => void)({
					target: { value: "   " },
				});
			};
			clear();
			const save = render().find(
				(node) =>
					node.type === Button && node.props.children === "Save Changes",
			);
			expect(save?.props.disabled).toBe(false);
			(save?.props.onClick as () => void)();
			// useCreateCombo is registered first, useUpdateCombo second.
			const update =
				mutations.find((m) => (m.vars as { id?: string })?.id === combo.id) ??
				mutations[1];
			expect(update?.vars).toEqual({
				id: combo.id,
				name: "My Combo",
				description: "",
			});
			// The body must actually carry the field, not drop it.
			expect(JSON.parse(JSON.stringify(update?.vars))).toHaveProperty(
				"description",
				"",
			);
		} finally {
			restore();
		}
	});
});
