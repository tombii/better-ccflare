import { describe, expect, it } from "bun:test";
import type { ApiKeyUsageResponse } from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

function renderOwnPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(queryKeys.apiKeyUsage("team app", "24h"), usage);
	const markup = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/api-keys/team%20app"]}>
				<Routes>
					<Route path="/api-keys/:name" element={<ApiKeyUsageTab />} />
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
		expect(markup).not.toContain('href="/accounts"');
		expect(markup).not.toContain('href="/api-keys"');
	});
});
