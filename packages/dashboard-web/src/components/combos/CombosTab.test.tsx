import { describe, expect, it, spyOn } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import * as ReactQuery from "@tanstack/react-query";
import * as React from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { ComboCard } from "./ComboCard";
import { CombosTab } from "./CombosTab";

type Element = React.ReactElement<Record<string, unknown>>;

function elements(node: React.ReactNode): Element[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
	return [node as Element, ...elements(node.props.children)];
}

const combo = {
	id: "combo-1",
	name: "My Combo",
	description: null,
	enabled: true,
	created_at: 0,
	updated_at: 0,
	slot_count: 2,
};

interface SetupOptions {
	families?: { family: string; combo_id: string | null }[];
	apiKeys?: { isLoading?: boolean; isError?: boolean; data?: unknown };
}

/** Renders CombosTab by walking its element tree (no DOM). */
function setup(options: SetupOptions = {}) {
	const deleteMutate = (id: string, options?: { onSuccess?: () => void }) => {
		calls.push(id);
		options?.onSuccess?.();
	};
	const calls: string[] = [];
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
	const apiKeysOptions = options.apiKeys;
	const client = { clear: () => {} } as unknown as QueryClient;
	const queryClient = spyOn(ReactQuery, "useQueryClient").mockReturnValue(
		client,
	);
	const query = spyOn(ReactQuery, "useQuery").mockImplementation(
		((queryOptions: { queryKey: unknown[] }) => {
			const key = queryOptions.queryKey.join("/");
			// useApiKeys unwraps the envelope in its queryFn, which this mock
			// replaces, so its cached data is the array itself.
			const data = key.endsWith("api-keys")
				? (apiKeysOptions?.data ?? [
						{ id: "k1", familyComboOverrides: { opus: combo.id } },
					])
				: key.endsWith("combos")
					? { combos: [combo] }
					: key.endsWith("families")
						? {
								families: options.families ?? [
									{ family: "opus", combo_id: combo.id },
								],
							}
						: undefined;
			const apiKeys = key.endsWith("api-keys");
			return {
				data,
				isLoading: apiKeys ? (apiKeysOptions?.isLoading ?? false) : false,
				isError: apiKeys ? (apiKeysOptions?.isError ?? false) : false,
			};
		}) as never,
	);
	const mutation = spyOn(ReactQuery, "useMutation").mockReturnValue({
		mutate: deleteMutate,
		isPending: false,
		isError: false,
		reset: () => {},
	} as never);
	function render() {
		cursor = 0;
		return elements(CombosTab());
	}
	function deleteDialog(tree: Element[]) {
		return tree.find((node) => {
			if (node.type !== Dialog) return false;
			const content = elements(node).find(
				(child) => child.type === DialogContent,
			);
			return content
				? elements(content).some(
						(child) =>
							typeof child.props.children === "string" &&
							child.props.children === "Delete combo?",
					)
				: false;
		});
	}
	function restore() {
		for (const spy of [state, queryClient, query, mutation]) spy.mockRestore();
	}
	/** Opens the delete confirmation and returns its rendered text. */
	function openDeleteDialog() {
		const card = render().find((node) => node.type === ComboCard);
		(card?.props.onDelete as () => void)();
		// First render observes the open dialog, the second the post-effect
		// state (the keys query is only enabled once a delete is pending).
		render();
		const dialog = deleteDialog(render());
		const text = elements(dialog)
			.map((node) => node.props.children)
			.filter((child): child is string => typeof child === "string")
			.join("");
		const confirm = elements(dialog).find(
			(node) => node.type === Button && node.props.children === "Delete",
		);
		return { text, confirm };
	}
	return { render, deleteDialog, calls, restore, openDeleteDialog };
}

describe("CombosTab delete confirmation", () => {
	it("does not delete on the first click; requires confirming in a dialog", () => {
		const { render, deleteDialog, calls, restore } = setup();
		try {
			expect(deleteDialog(render())?.props.open).toBe(false);

			const trash = render().find((node) => node.type === ComboCard);
			(trash?.props.onDelete as () => void)();
			expect(calls).toEqual([]);

			const dialog = deleteDialog(render());
			expect(dialog?.props.open).toBe(true);
			// Every string rendered anywhere in the dialog, joined.
			const text = elements(dialog)
				.flatMap((node) => [node, ...elements(node.props.children)])
				.map((node) => node.props.children)
				.filter((child): child is string => typeof child === "string")
				.join("");
			// Names the combo and its slot count, and warns about the family
			// and the API key override that depend on it.
			expect(text).toContain('"My Combo"');
			expect(text).toContain("2 slots");
			expect(text).toContain("Opus");

			const confirm = elements(dialog).find(
				(node) => node.type === Button && node.props.children === "Delete",
			);
			expect(confirm?.props.variant).toBe("destructive");
			(confirm?.props.onClick as () => void)();
			expect(calls).toEqual([combo.id]);
			// Success closes the confirmation.
			expect(deleteDialog(render())?.props.open).toBe(false);
		} finally {
			restore();
		}
	});

	it("cancelling closes the confirmation without deleting", () => {
		const { render, deleteDialog, calls, restore } = setup();
		try {
			const card = render().find((node) => node.type === ComboCard);
			(card?.props.onDelete as () => void)();
			const dialog = deleteDialog(render());
			const cancel = elements(dialog).find(
				(node) => node.type === Button && node.props.children === "Cancel",
			);
			expect(cancel?.props.variant).toBe("outline");
			(cancel?.props.onClick as () => void)();
			expect(calls).toEqual([]);
			expect(deleteDialog(render())?.props.open).toBe(false);
		} finally {
			restore();
		}
	});

	it("names every family routed through the combo", () => {
		const { restore, openDeleteDialog } = setup({
			families: [
				{ family: "opus", combo_id: combo.id },
				{ family: "sonnet", combo_id: combo.id },
				{ family: "haiku", combo_id: "other" },
			],
		});
		try {
			const { text } = openDeleteDialog();
			expect(text).toContain(
				"Opus and Sonnet route through this combo and will fall back to normal pool routing.",
			);
			expect(text).not.toContain("Haiku");
		} finally {
			restore();
		}
	});

	it("disables Delete and says so while API key overrides are loading", () => {
		const { restore, openDeleteDialog } = setup({
			apiKeys: { isLoading: true },
		});
		try {
			const { text, confirm } = openDeleteDialog();
			expect(confirm?.props.disabled).toBe(true);
			expect(text).toContain("Checking API key overrides...");
			expect(text).not.toContain("override a family");
		} finally {
			restore();
		}
	});

	it("disables Delete and reports an error when the override check fails", () => {
		const { restore, openDeleteDialog } = setup({ apiKeys: { isError: true } });
		try {
			const { text, confirm } = openDeleteDialog();
			expect(confirm?.props.disabled).toBe(true);
			expect(text).toContain("Could not check API key overrides.");
		} finally {
			restore();
		}
	});
});
