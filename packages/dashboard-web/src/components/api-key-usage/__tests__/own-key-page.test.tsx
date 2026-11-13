import { describe, expect, it, spyOn } from "bun:test";
import type {
	ApiKeyResponse,
	ApiKeyUsageResponse,
} from "@better-ccflare/types";
import * as ReactQuery from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Router from "react-router-dom";
import { MemoryRouter } from "react-router-dom";
import { api } from "../../../api";
import { queryKeys } from "../../../lib/query-keys";
import { ApiKeysTab } from "../../ApiKeysTab";
import { Input } from "../../ui/input";
import * as SelectUI from "../../ui/select";
import { ApiKeyUsageTab } from "../ApiKeyUsageTab";

const usage: ApiKeyUsageResponse = {
	apiKey: { id: "own", name: "team app", isActive: true, role: "api-only" },
	canManage: false,
	limitWindowMode: "calendar",
	familyComboOverrides: null,
	limits: [
		{
			id: "limit",
			apiKeyId: "own",
			scopeModel: "opus",
			window: "day",
			limitUsd: 5,
			enforce: "block",
			createdAt: 0,
			updatedAt: 0,
			spentUsd: 2,
			resetsAt: "2026-11-14T00:00:00.000Z",
		},
	],
	range: "24h",
	windowStartMs: 0,
	windowEndMs: 3600000,
	bucketMs: 60000,
	requests: 3,
	successfulRequests: 3,
	successRate: 100,
	tokens: {
		inputTokens: 100,
		outputTokens: 20,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalTokens: 120,
	},
	apiCostUsd: 1,
	planValueUsd: 1,
	totalCostUsd: 2,
	planCost: {
		planCostUsd: 0,
		pricedPlanValueUsd: 0,
		accounts: [],
		unpricedAccountIds: [],
		windowDays: 1,
	},
	efficiencyRatio: null,
	efficiencyStatus: "unpriced",
	models: [],
	accounts: [],
	series: [],
	unknownPricingModels: [],
	limit: { limitUsd: null, limitWindow: null, limitEnforce: null },
	restrictions: {
		allowedAccounts: null,
		allowedModels: ["opus"],
		allowedProviders: ["codex"],
	},
};

const keys: ApiKeyResponse[] = [
	{ id: "disabled", name: "Disabled", isActive: false },
	{ id: "own", name: "team app", isActive: true },
	{ id: "second", name: "Second key", isActive: true },
].map((key) => ({
	...key,
	role: "api-only",
	prefixLast8: "abcd1234",
	createdAt: "2026-11-01",
	lastUsed: null,
	usageCount: 0,
	allowedAccounts: null,
	allowedModels: null,
	allowedProviders: null,
	limitUsd: null,
	limitWindow: null,
	limitEnforce: null,
}));

function renderPage({
	admin = false,
	path = "/api-key-usage",
	enabled = true,
	data = usage,
}: {
	admin?: boolean;
	path?: string;
	enabled?: boolean;
	data?: ApiKeyUsageResponse;
} = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(["cost-tracking"], { enabled });
	client.setQueryData(["auth-session"], { canManage: admin, apiKeyId: "own" });
	client.setQueryData(queryKeys.apiKeys(), keys);
	for (const key of keys)
		client.setQueryData(queryKeys.apiKeyUsage(key.id, "24h"), {
			...data,
			canManage: admin,
			apiKey: { ...data.apiKey, id: key.id, name: key.name },
		});
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={[path]}>
					<ApiKeyUsageTab />
				</MemoryRouter>
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}

describe("API Key Usage page", () => {
	it("uses the Usage History header and keeps administration in API Keys dialogs", () => {
		const markup = renderPage({ admin: true });
		expect(markup).toContain('aria-label="Select API key"');
		expect(markup).toMatch(/<button[^>]*class="[^"]*w-64[^"]*"[^>]*>/);
		expect(markup).toMatch(/<button[^>]*class="[^"]*w-28[^"]*"[^>]*>/);
		for (const text of [
			"Plan efficiency",
			"Total API-cost equivalent",
			"Cost over time",
			"Models used",
			"By model",
			"By account",
			"Current limits",
			"Reset spend",
		])
			expect(markup).toContain(text);
		for (const text of [
			"Save restrictions",
			"Save limits",
			"Save routing",
			"Routing overrides",
			"Allowed providers",
		])
			expect(markup).not.toContain(text);
	});
	it("shows only the caller's name, stats and gauges for API-only keys, even with another query key", () => {
		const markup = renderPage({ path: "/api-key-usage?key=second" });
		expect(markup).toContain("team app");
		expect(markup).toContain("Total API-cost equivalent");
		expect(markup).toContain("Current limits");
		expect(markup).toContain("opus");
		for (const text of [
			'aria-label="Select API key"',
			"Second key",
			"Save restrictions",
			"Save limits",
			"Save routing",
			"Reset spend",
		])
			expect(markup).not.toContain(text);
	});
	it("keeps the cost-disabled notice and hides costs without hiding attempt metrics", () => {
		const markup = renderPage({ enabled: false });
		expect(markup).toContain("Cost tracking is disabled");
		expect(markup).toContain("Spend limits are not enforced");
		expect(markup).toContain("Successful attempts");
		expect(markup).not.toContain("$1.0000");
		expect(markup).not.toContain("$2.0000");
	});
	it("preserves reset audit, and disables an admin reset when there are no limits", () => {
		const data = {
			...usage,
			apiKey: {
				...usage.apiKey,
				spendResetAt: 1_795_000_000_000,
				spendResetBy: "operator",
			},
		};
		const markup = renderPage({ admin: true, data });
		expect(markup).toContain("Spend reset at");
		expect(markup).toContain("by operator");
		expect(markup).toContain("Reset spend</button>");
		expect(renderPage({ admin: true, data: { ...data, limits: [] } })).toMatch(
			/<button[^>]*disabled=""[^>]*>Reset spend<\/button>/,
		);
	});
	it("retains attempt and recovery semantics", () => {
		const markup = renderPage({
			data: {
				...usage,
				requests: 2,
				successfulRequests: 1,
				failedAttempts: 1,
				failoverAttempts: 1,
				recoveredRequests: 1,
				successRate: 50,
			},
		});
		for (const text of [
			"Successful attempts",
			"Failed attempts",
			"Failover attempts",
			"including 1 recovered after failover",
			"Client-visible failure totals cannot be inferred",
		])
			expect(markup).toContain(text);
	});
	it("restores plain key names and removes the Stats action on API Keys", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(queryKeys.apiKeys(), keys);
		client.setQueryData(["cost-tracking"], { enabled: true });
		try {
			const previousStorage = globalThis.localStorage;
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: { getItem: () => null },
			});
			let markup: string;
			try {
				markup = renderToStaticMarkup(
					<QueryClientProvider client={client}>
						<MemoryRouter>
							<ApiKeysTab />
						</MemoryRouter>
					</QueryClientProvider>,
				);
			} finally {
				Object.defineProperty(globalThis, "localStorage", {
					configurable: true,
					value: previousStorage,
				});
			}
			expect(markup).toContain('<h3 class="font-medium">team app</h3>');
			expect(markup).not.toMatch(/>Stats<\/a>/);
			expect(markup).not.toContain('href="/api-keys/');
		} finally {
			client.clear();
		}
	});
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
	if (Array.isArray(node)) return node.flatMap(elements);
	if (!React.isValidElement<{ children?: ReactNode }>(node)) return [];
	return [
		node as ReactElement<Record<string, unknown>>,
		...elements(node.props.children),
	];
}

/**
 * Exercise the component's real control handlers and query functions without a
 * browser. State survives renders; child components are left as elements, so
 * the harness only replaces the page's React hooks and query responses.
 */
function pageHarness({
	path = "/api-key-usage",
	session = { canManage: true, apiKeyId: "admin" } as
		| { canManage: boolean; apiKeyId: string | null }
		| undefined,
}: {
	path?: string;
	session?: { canManage: boolean; apiKeyId: string | null };
} = {}) {
	const states: unknown[] = [];
	let cursor = 0;
	let changed = false;
	let currentSession = session;
	let tree: ReactNode;
	const queries: Parameters<typeof ReactQuery.useQuery>[0][] = [];
	const url = new URL(path, "https://local");
	const location = {
		pathname: url.pathname,
		search: url.search,
		hash: "",
		state: null,
		key: "test",
	};
	const client = new QueryClient();
	const stateSpy = spyOn(React, "useState").mockImplementation(((
		initial: unknown,
	) => {
		const index = cursor++;
		if (!(index in states))
			states[index] = typeof initial === "function" ? initial() : initial;
		return [
			states[index],
			(next: unknown) => {
				const value = typeof next === "function" ? next(states[index]) : next;
				if (!Object.is(value, states[index])) {
					states[index] = value;
					changed = true;
				}
			},
		];
	}) as typeof React.useState);
	const memoSpy = spyOn(React, "useMemo").mockImplementation((factory) =>
		factory(),
	);
	const querySpy = spyOn(ReactQuery, "useQuery").mockImplementation(((
		options: Parameters<typeof ReactQuery.useQuery>[0],
	) => {
		queries.push(options);
		let data: unknown;
		if (options.queryKey?.includes("auth-session")) data = currentSession;
		if (options.queryKey?.includes("cost-tracking")) data = { enabled: true };
		if (options.queryKey?.includes("api-keys"))
			data = options.enabled === false ? undefined : keys;
		if (options.queryKey?.includes("api-key-usage")) {
			const target = options.queryKey.find(
				(part) => typeof part === "object" && part !== null && "keyId" in part,
			) as { keyId: string };
			const key = keys.find((candidate) => candidate.id === target.keyId);
			if (key && options.enabled !== false)
				data = {
					...usage,
					canManage: currentSession?.canManage ?? false,
					apiKey: { ...usage.apiKey, ...key },
				};
		}
		return { data, isLoading: false, error: null };
	}) as typeof ReactQuery.useQuery);
	const clientSpy = spyOn(ReactQuery, "useQueryClient").mockReturnValue(client);
	const mutationSpy = spyOn(ReactQuery, "useMutation").mockReturnValue(
		{} as never,
	);
	const locationSpy = spyOn(Router, "useLocation").mockReturnValue(location);
	const navigateSpy = spyOn(Router, "useNavigate").mockReturnValue(
		(() => {}) as never,
	);
	const fetchSpy = spyOn(api, "getApiKeyUsage").mockResolvedValue(usage);
	function render() {
		for (let attempts = 0; attempts < 10; attempts++) {
			cursor = 0;
			changed = false;
			tree = ApiKeyUsageTab();
			if (!changed) break;
		}
		return elements(tree);
	}
	return {
		render,
		queries,
		location,
		navigateSpy,
		fetchSpy,
		setSession(value: typeof currentSession) {
			currentSession = value;
		},
		selects() {
			return elements(tree).filter(
				(element) => element.type === SelectUI.Select,
			) as ReactElement<ComponentProps<typeof SelectUI.Select>>[];
		},
		inputs() {
			return elements(tree).filter(
				(element) => element.type === Input,
			) as ReactElement<ComponentProps<typeof Input>>[];
		},
		usageQuery() {
			return queries.findLast((option) =>
				option.queryKey?.includes("api-key-usage"),
			);
		},
		async fetchUsage() {
			const query = queries.findLast((option) =>
				option.queryKey?.includes("api-key-usage"),
			);
			expect(typeof query?.queryFn).toBe("function");
			await (query?.queryFn as () => Promise<unknown>)();
		},
		restore() {
			for (const spy of [
				stateSpy,
				memoSpy,
				querySpy,
				clientSpy,
				mutationSpy,
				locationSpy,
				navigateSpy,
				fetchSpy,
			])
				spy.mockRestore();
			client.clear();
		},
	};
}

describe("API Key Usage controls", () => {
	it("defaults to the first active key, and refetches key and range changes in place", async () => {
		const page = pageHarness();
		try {
			page.render();
			expect(page.selects().map((element) => element.props.value)).toEqual([
				"own",
				"24h",
			]);
			page.selects()[1].props.onValueChange?.("7d");
			page.render();
			await page.fetchUsage();
			expect(page.fetchSpy).toHaveBeenLastCalledWith(
				"own",
				"7d",
				undefined,
				undefined,
			);
			page.selects()[0].props.onValueChange?.("second");
			page.render();
			await page.fetchUsage();
			expect(page.selects().map((element) => element.props.value)).toEqual([
				"second",
				"7d",
			]);
			expect(page.fetchSpy).toHaveBeenLastCalledWith(
				"second",
				"7d",
				undefined,
				undefined,
			);
			expect(page.navigateSpy).not.toHaveBeenCalled();
			expect(page.location.pathname).toBe("/api-key-usage");
			expect(page.location.search).toBe("");
		} finally {
			page.restore();
		}
	});
	it("preselects an optional query key and offers all Usage History ranges plus month and custom", () => {
		const page = pageHarness({ path: "/api-key-usage?key=second" });
		try {
			page.render();
			expect(page.selects()[0].props.value).toBe("second");
			const options = elements(page.selects()[1])
				.filter((element) => element.type === SelectUI.SelectItem)
				.map((element) => element.props.value);
			expect(options).toEqual([
				"1h",
				"6h",
				"24h",
				"7d",
				"30d",
				"this_month",
				"last_month",
				"custom",
			]);
			for (const range of ["6h", "this_month", "last_month"]) {
				page.selects()[1].props.onValueChange?.(range);
				page.render();
				expect(page.usageQuery()?.queryKey).toEqual(
					queryKeys.apiKeyUsage("second", range),
				);
			}
			expect(page.navigateSpy).not.toHaveBeenCalled();
		} finally {
			page.restore();
		}
	});
	it("keeps an admin selector available when a preselected key was deleted", async () => {
		const page = pageHarness({ path: "/api-key-usage?key=deleted" });
		try {
			page.render();
			expect(page.selects()).toHaveLength(2);
			expect(page.selects()[0].props.value).toBe("deleted");
			page.selects()[0].props.onValueChange?.("own");
			page.render();
			await page.fetchUsage();
			expect(page.fetchSpy).toHaveBeenLastCalledWith(
				"own",
				"24h",
				undefined,
				undefined,
			);
			expect(page.navigateSpy).not.toHaveBeenCalled();
		} finally {
			page.restore();
		}
	});
	it("reveals custom bounds inline and refetches only after valid dates are entered", async () => {
		const page = pageHarness();
		try {
			const initial = page.render();
			expect(page.inputs()).toHaveLength(0);
			page.selects()[1].props.onValueChange?.("custom");
			const nodes = page.render();
			expect(page.usageQuery()?.enabled).toBe(false);
			const header = nodes.find(
				(element) =>
					element.type === "div" &&
					elements(element.props.children as ReactNode).some(
						(child) => child.type === SelectUI.Select,
					) &&
					element !== nodes[0],
			);
			expect(
				elements(header).filter((element) => element.type === Input),
			).toHaveLength(2);
			const update = (id: string, value: string) => {
				page
					.inputs()
					.find((element) => element.props.id === id)
					?.props.onChange?.({
						target: { value },
					} as React.ChangeEvent<HTMLInputElement>);
				page.render();
			};
			update("usage-from", "2026-11-02T12:00");
			update("usage-to", "2026-11-01T12:00");
			expect(page.usageQuery()?.enabled).toBe(false);
			update("usage-to", "2026-11-03T12:00");
			expect(page.usageQuery()?.enabled).toBe(true);
			await page.fetchUsage();
			expect(page.fetchSpy).toHaveBeenLastCalledWith(
				"own",
				"custom",
				new Date("2026-11-02T12:00").toISOString(),
				new Date("2026-11-03T12:00").toISOString(),
			);
			expect(page.navigateSpy).not.toHaveBeenCalled();
			expect(initial[0].props.className).toBe("space-y-4");
		} finally {
			page.restore();
		}
	});
	it("does not query other keys for an API-only caller or before its session resolves", () => {
		const page = pageHarness({
			path: "/api-key-usage?key=second",
			session: { canManage: false, apiKeyId: "own" },
		});
		try {
			page.setSession(undefined);
			page.render();
			expect(page.usageQuery()?.enabled).toBe(false);
			page.setSession({ canManage: false, apiKeyId: "own" });
			page.render();
			expect(page.selects()).toHaveLength(1);
			expect(page.usageQuery()?.queryKey).toEqual(
				queryKeys.apiKeyUsage("own", "24h"),
			);
			expect(
				page.queries
					.filter((query) => query.queryKey?.includes("api-keys"))
					.every((query) => query.enabled === false),
			).toBe(true);
		} finally {
			page.restore();
		}
	});
});
