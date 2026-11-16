import { describe, expect, it, spyOn } from "bun:test";
import type { ApiKeyResponse } from "@better-ccflare/types";
import * as ReactQuery from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { ApiKeysTab } from "./ApiKeysTab";
import { ApiKeyRoutingEditor } from "./api-keys/ApiKeyRoutingEditor";
import { Dialog } from "./ui/dialog";
import { DropdownMenuItem } from "./ui/dropdown-menu";

function elements(
	node: React.ReactNode,
): React.ReactElement<Record<string, unknown>>[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
	return [
		node as React.ReactElement<Record<string, unknown>>,
		...elements(node.props.children),
	];
}

describe("API key routing editor", () => {
	it("opens the selected key's routing editor from its menu and closes it", () => {
		const key = {
			id: "key-id",
			name: "Team app",
			role: "admin",
			isActive: true,
			createdAt: 1,
			usageCount: 0,
			prefixLast8: "12345678",
			allowedAccounts: null,
			allowedModels: null,
			allowedProviders: null,
			familyComboOverrides: { opus: "combo-id" },
		} as ApiKeyResponse;
		const states: unknown[] = [];
		let cursor = 0;
		const client = new QueryClient();
		const state = spyOn(React, "useState").mockImplementation(((
			initial: unknown,
		) => {
			const index = cursor++;
			if (!(index in states))
				states[index] = typeof initial === "function" ? initial() : initial;
			return [
				states[index],
				(next: unknown) => {
					states[index] =
						typeof next === "function" ? next(states[index]) : next;
				},
			];
		}) as typeof React.useState);
		const effect = spyOn(React, "useEffect").mockImplementation(() => {});
		const memo = spyOn(React, "useMemo").mockImplementation((factory) =>
			factory(),
		);
		const query = spyOn(ReactQuery, "useQuery").mockImplementation(((options: {
			queryKey: unknown[];
		}) => ({
			data: options.queryKey.includes("api-keys")
				? [key]
				: options.queryKey.includes("accounts")
					? []
					: undefined,
			isLoading: false,
			error: null,
		})) as never);
		const queryClient = spyOn(ReactQuery, "useQueryClient").mockReturnValue(
			client,
		);
		const mutation = spyOn(ReactQuery, "useMutation").mockReturnValue({
			reset() {},
		} as never);
		function render() {
			cursor = 0;
			return elements(ApiKeysTab());
		}
		try {
			// The text is a direct child alongside its icon.
			const routingMenu = render().find(
				(node) =>
					node.type === DropdownMenuItem &&
					(node.props.children as unknown[]).includes("Edit routing"),
			);
			expect(routingMenu).toBeDefined();
			(routingMenu?.props.onClick as () => void)();
			const opened = render();
			const editor = opened.find((node) => node.type === ApiKeyRoutingEditor);
			expect(editor?.props.keyId).toBe(key.id);
			expect(editor?.props.overrides).toEqual({ opus: "combo-id" });
			const dialog = opened.find(
				(node) =>
					node.type === Dialog &&
					elements(node).some((child) => child === editor),
			);
			expect(dialog?.props.open).toBe(true);
			(dialog?.props.onOpenChange as (open: boolean) => void)(false);
			expect(render().some((node) => node.type === ApiKeyRoutingEditor)).toBe(
				false,
			);
		} finally {
			for (const spy of [state, effect, memo, query, queryClient, mutation])
				spy.mockRestore();
			client.clear();
		}
	});
});

describe("API key spend limits editor", () => {
	it("cannot open the editor for a key whose limits failed to load", () => {
		const key = (id: string, limits?: unknown[]) =>
			({
				id,
				name: id,
				role: "admin",
				isActive: true,
				createdAt: 1,
				usageCount: 0,
				prefixLast8: "12345678",
				allowedAccounts: null,
				allowedModels: null,
				allowedProviders: null,
				...(limits ? { limits } : {}),
			}) as ApiKeyResponse;
		const keys = [key("unreadable"), key("readable", [])];
		const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: { getItem: () => null },
		});
		const client = new QueryClient();
		const state = spyOn(React, "useState").mockImplementation(((
			initial: unknown,
		) => [
			typeof initial === "function" ? initial() : initial,
			() => {},
		]) as typeof React.useState);
		const effect = spyOn(React, "useEffect").mockImplementation(() => {});
		const memo = spyOn(React, "useMemo").mockImplementation((factory) =>
			factory(),
		);
		const query = spyOn(ReactQuery, "useQuery").mockImplementation(((options: {
			queryKey: unknown[];
		}) => ({
			data: options.queryKey.includes("api-keys")
				? keys
				: options.queryKey.includes("accounts")
					? []
					: undefined,
			isLoading: false,
			error: null,
		})) as never);
		const queryClient = spyOn(ReactQuery, "useQueryClient").mockReturnValue(
			client,
		);
		const mutation = spyOn(ReactQuery, "useMutation").mockReturnValue({
			reset() {},
		} as never);
		try {
			const items = elements(ApiKeysTab()).filter(
				(node) =>
					node.type === DropdownMenuItem &&
					(node.props.children as unknown[]).includes("Edit spend limits"),
			);
			expect(items.map((item) => item.props.disabled)).toEqual([true, false]);
		} finally {
			for (const spy of [state, effect, memo, query, queryClient, mutation])
				spy.mockRestore();
			client.clear();
			if (storage) Object.defineProperty(globalThis, "localStorage", storage);
			else delete (globalThis as { localStorage?: unknown }).localStorage;
		}
	});
});
