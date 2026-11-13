import { describe, expect, it, spyOn } from "bun:test";
import type { ApiKeyUsageResponse } from "@better-ccflare/types";
import * as ReactQuery from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../../../api";
import { queryKeys } from "../../../lib/query-keys";
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
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	for (const [target, data] of entries)
		client.setQueryData(queryKeys.apiKeyUsage(target, "24h"), data);
	const markup = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/api-keys/:keyId" element={<ApiKeyUsageTab />} />
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
