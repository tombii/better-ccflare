import { describe, expect, it, spyOn } from "bun:test";
import type { ApiKeyUsageResponse } from "@better-ccflare/types";
import * as ReactQuery from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Router from "react-router-dom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../../../api";
import { queryKeys } from "../../../lib/query-keys";
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

function renderOwnPage(
	path = "/api-keys/team%20app",
	entries: Array<[string, ApiKeyUsageResponse]> = [["team app", usage]],
	costTracking = true,
	callerAccess?: { canManage: boolean; apiKeyId: string | null },
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(["cost-tracking"], { enabled: costTracking });
	if (callerAccess) client.setQueryData(["auth-session"], callerAccess);
	for (const [target, data] of entries)
		client.setQueryData(
			queryKeys.apiKeyUsage(
				target,
				new URL(path, "https://local").searchParams.get("range") ?? "24h",
			),
			data,
		);
	const markup = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/api-keys/:keyId" element={<ApiKeyUsageTab />} />
					<Route path="/api-key-usage" element={<ApiKeyUsageTab />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	client.clear();
	return markup;
}

describe("API-only key page", () => {
	it("shows own stats, restrictions, and scoped gauges while hiding administration", () => {
		const markup = renderOwnPage();
		expect(markup).toContain("team app");
		expect(markup).not.toContain('aria-label="Select API key"');
		expect(markup).toContain("Total API-cost equivalent");
		expect(markup).toContain("opus");
		expect(markup).toContain("codex");
		expect(markup).toContain("calendar");
		expect(markup).not.toContain("Save restrictions");
		expect(markup).not.toContain("Save limits");
		expect(markup).not.toContain("Save routing");
		expect(markup).not.toContain("Reset spend");
		expect(markup).not.toContain('href="/accounts"');
		expect(markup).not.toContain('href="/api-keys"');
	});
	it("retains the admin selector on direct key routes and keeps the selected range in the URL", () => {
		const admin = { ...usage, canManage: true };
		const markup = renderOwnPage("/api-keys/own?range=7d", [["own", admin]]);
		expect(markup).toContain('aria-label="Select API key"');
		expect(markup).toContain("7 days");
		expect(markup).not.toContain('href="/api-keys"');
	});
	it("labels raw rows as attempts and separates successful recoveries from failed attempts", () => {
		const markup = renderOwnPage("/api-keys/own", [
			[
				"own",
				{
					...usage,
					requests: 2,
					successfulRequests: 1,
					failedAttempts: 1,
					failoverAttempts: 1,
					recoveredRequests: 1,
					successRate: 50,
				},
			],
		]);
		expect(markup).toContain("Successful attempts");
		expect(markup).toContain("Failed attempts");
		expect(markup).toContain("Failover attempts");
		expect(markup).toContain("including 1 recovered after failover");
		expect(markup).toContain(
			"Client-visible failure totals cannot be inferred",
		);
		expect(markup).not.toContain('label="Requests"');
	});

	it("switches keys in place, pushes the URL and refetches the selected key with its existing range", async () => {
		const selections: ComponentProps<typeof SelectUI.Select>[] = [];
		const queryOptions: Parameters<typeof ReactQuery.useQuery>[0][] = [];
		const originalSelect = SelectUI.Select;
		const originalQuery = ReactQuery.useQuery;
		const navigate = () => {};
		const calls: unknown[][] = [];
		const selectSpy = spyOn(SelectUI, "Select").mockImplementation((props) => {
			selections.push(props);
			return originalSelect(props);
		});
		const navigateSpy = spyOn(Router, "useNavigate").mockReturnValue(((
			...args: unknown[]
		) => {
			calls.push(args);
			navigate();
		}) as ReturnType<typeof Router.useNavigate>);
		const querySpy = spyOn(ReactQuery, "useQuery").mockImplementation(((
			options: Parameters<typeof ReactQuery.useQuery>[0],
		) => {
			queryOptions.push(options);
			return originalQuery(options);
		}) as typeof ReactQuery.useQuery);
		const fetchSpy = spyOn(api, "getApiKeyUsage").mockResolvedValue(usage);
		try {
			const first = renderOwnPage("/api-keys/own?range=7d", [
				["own", { ...usage, canManage: true }],
			]);
			selections
				.find((option) => option.value === "own")
				?.onValueChange?.("second");
			expect(calls).toEqual([["/api-keys/second?range=7d"]]);
			const second = renderOwnPage(calls[0][0] as string, [
				[
					"second",
					{
						...usage,
						canManage: true,
						apiKey: { ...usage.apiKey, id: "second", name: "Second key" },
					},
				],
			]);
			expect(first).toContain('aria-label="Select API key"');
			expect(second).toContain('aria-label="Select API key"');
			expect(second).toContain("Second key");
			expect(second).toContain("7 days");
			const usageQueries = queryOptions.filter((option) =>
				option.queryKey?.includes("api-key-usage"),
			);
			const fetchSelected = usageQueries.findLast((option) =>
				option.queryKey?.some(
					(part) =>
						typeof part === "object" &&
						part !== null &&
						"keyId" in part &&
						part.keyId === "second",
				),
			)?.queryFn;
			expect(typeof fetchSelected).toBe("function");
			await (fetchSelected as () => Promise<unknown>)();
			expect(fetchSpy).toHaveBeenCalledWith(
				"second",
				"7d",
				undefined,
				undefined,
			);
		} finally {
			selectSpy.mockRestore();
			navigateSpy.mockRestore();
			querySpy.mockRestore();
			fetchSpy.mockRestore();
		}
	});

	it("hides cost values and warns that limits are suspended on the API-only page", () => {
		const markup = renderOwnPage("/api-keys/own", [["own", usage]], false);
		expect(markup).toContain("Cost tracking is disabled");
		expect(markup).toContain("Spend limits are not enforced");
		expect(markup).not.toContain("$1.0000");
		expect(markup).not.toContain("$2.0000");
		expect(markup).toContain("Successful attempts");
		expect(markup).not.toContain('aria-label="Select API key"');
	});

	it("retains the admin selector when the direct target has no usage response", () => {
		const markup = renderOwnPage("/api-keys/deleted", [], true, {
			canManage: true,
			apiKeyId: "admin",
		});
		expect(markup).toContain('aria-label="Select API key"');
	});
	it("opens the overview as the API-only caller's own key without querying the admin list", () => {
		const queries: Parameters<typeof ReactQuery.useQuery>[0][] = [];
		const original = ReactQuery.useQuery;
		const spy = spyOn(ReactQuery, "useQuery").mockImplementation(((
			options: Parameters<typeof ReactQuery.useQuery>[0],
		) => {
			queries.push(options);
			return original(options);
		}) as typeof ReactQuery.useQuery);
		try {
			const markup = renderOwnPage("/api-key-usage", [["own", usage]], true, {
				canManage: false,
				apiKeyId: "own",
			});
			expect(markup).toContain("team app");
			expect(markup).not.toContain('aria-label="Select API key"');
			expect(
				queries
					.filter((option) => option.queryKey?.includes("api-keys"))
					.every((option) => option.enabled === false),
			).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	it("offers an admin reset next to the gauges, disables it without limits, and shows its actor", () => {
		const admin: ApiKeyUsageResponse = {
			...usage,
			canManage: true,
			apiKey: {
				...usage.apiKey,
				spendResetAt: 1_795_000_000_000,
				spendResetBy: "operator",
			},
		};
		const markup = renderOwnPage("/api-keys/own", [["own", admin]]);
		expect(markup).toContain("Reset spend</button>");
		expect(markup).toContain("Spend reset at");
		expect(markup).toContain("by operator");
		const unlimited = renderOwnPage("/api-keys/own", [
			["own", { ...admin, limits: [] }],
		]);
		expect(unlimited).toMatch(
			/<button[^>]*disabled=""[^>]*>Reset spend<\/button>/,
		);
	});
	it("keeps literal escaped slashes distinct from slashes when both key names exist", () => {
		const escaped: ApiKeyUsageResponse = {
			...usage,
			apiKey: { ...usage.apiKey, id: "escaped-key-id", name: "team%2Fapp" },
			canManage: true,
		};
		const slash: ApiKeyUsageResponse = {
			...usage,
			apiKey: { ...usage.apiKey, id: "slash-key-id", name: "team/app" },
			canManage: true,
		};
		const entries: Array<[string, ApiKeyUsageResponse]> = [
			[escaped.apiKey.name, escaped],
			[slash.apiKey.name, slash],
			[escaped.apiKey.id, escaped],
			[slash.apiKey.id, slash],
		];
		for (const [path, ownId, otherId, ownName] of [
			[
				"/api-keys/team%252Fapp",
				"escaped-key-id",
				"slash-key-id",
				"team%2Fapp",
			],
			["/api-keys/team%2Fapp", "slash-key-id", "escaped-key-id", "team/app"],
			[
				"/api-keys/escaped-key-id",
				"escaped-key-id",
				"slash-key-id",
				"team%2Fapp",
			],
			["/api-keys/slash-key-id", "slash-key-id", "escaped-key-id", "team/app"],
		]) {
			const markup = renderOwnPage(path, entries);
			expect(markup).toContain(`>${ownName}</h2>`);
			expect(markup).toContain(`id="calendar-limits-${ownId}"`);
			expect(markup).toContain(`id="routing-${ownId}-opus"`);
			expect(markup).not.toContain(`id="calendar-limits-${otherId}"`);
		}
	});
	it("saves restrictions by the resolved ID even when opened through a legacy escaped name", async () => {
		const escaped: ApiKeyUsageResponse = {
			...usage,
			apiKey: { ...usage.apiKey, id: "escaped-key-id", name: "team%2Fapp" },
			canManage: true,
		};
		const slash: ApiKeyUsageResponse = {
			...usage,
			apiKey: { ...usage.apiKey, id: "slash-key-id", name: "team/app" },
			canManage: true,
		};
		const originalUseMutation = ReactQuery.useMutation;
		const options: Parameters<typeof originalUseMutation>[0][] = [];
		const mutationSpy = spyOn(ReactQuery, "useMutation").mockImplementation(((
			...args: Parameters<typeof originalUseMutation>
		) => {
			options.push(args[0]);
			return originalUseMutation(...args);
		}) as typeof originalUseMutation);
		const patch = spyOn(api, "patch").mockResolvedValue({});
		try {
			renderOwnPage("/api-keys/team%252Fapp", [
				[escaped.apiKey.name, escaped],
				[slash.apiKey.name, slash],
			]);
			const save = options.findLast(
				(option) => option.mutationFn?.length === 1,
			)?.mutationFn;
			expect(save).toBeDefined();
			await (save as (value: typeof usage.restrictions) => Promise<unknown>)(
				usage.restrictions,
			);
			expect(patch).toHaveBeenCalledWith(
				"/api/api-keys/escaped-key-id/restrictions",
				usage.restrictions,
			);
		} finally {
			patch.mockRestore();
			mutationSpy.mockRestore();
		}
	});
});
