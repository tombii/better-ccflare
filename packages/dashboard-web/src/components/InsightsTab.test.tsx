import { describe, expect, it } from "bun:test";
import type {
	AnomalyInsightsResponse,
	CacheInsightsResponse,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { COST_TRACKING_QUERY_KEY } from "../hooks/useCostTracking";
import { queryKeys } from "../lib/query-keys";
import { InsightsTab } from "./InsightsTab";

const cacheRow = {
	key: "test-model",
	requests: 12,
	uncachedInputTokens: 1_000_000,
	cacheReadInputTokens: 2_000_000,
	cacheCreationInputTokens: 400_000,
	cacheHitRate: 58.8,
	actualCacheCostUsd: 2.1,
	counterfactualCostUsd: 7.2,
	savingsUsd: 5.1,
	pricingKnown: true,
	flagged: false,
};
const cache: CacheInsightsResponse = {
	meta: { range: "24h", thresholdPercent: 50, minRequestsForFlag: 10 },
	totals: { ...cacheRow, unknownPricingModels: [] },
	byModel: [cacheRow],
	byAccount: [cacheRow],
	byProject: [cacheRow],
};
const anomalies: AnomalyInsightsResponse = {
	meta: {
		range: "24h",
		zScoreThreshold: 3.5,
		minBaselineRequests: 10,
		baselineWindowMinutes: 1440,
		baselineWindowRequests: 12,
		loopWindowMinutes: 5,
		loopMinRequests: 10,
		loopSimilarityTolerance: 0.1,
		misroutingMaxTotalTokens: 100,
		misroutingMinOutputRateUsd: 10,
		misroutingMinRequests: 3,
		maxEventsPerDetector: 50,
		scannedRequests: 12,
		truncated: false,
	},
	baselines: [],
	tokenOutliers: [],
	outputBlowups: [],
	runawayLoops: [],
	tokenOutliersSummary: { totalCount: 0, truncated: false },
	outputBlowupsSummary: { totalCount: 0, truncated: false },
	runawayLoopsSummary: { totalCount: 0, truncated: false },
	misroutingSummary: { totalCount: 1, truncated: false },
	misrouting: [
		{
			account: "test-account",
			model: "test-model",
			requests: 12,
			meanTotalTokens: 50,
			outputRateUsd: 25,
			totalCostUsd: 123.45,
			exampleRequestIds: [],
		},
	],
};

function render(enabled: boolean) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(COST_TRACKING_QUERY_KEY, { enabled, source: "file" });
	client.setQueryData(queryKeys.insightsCache("24h"), cache);
	client.setQueryData(queryKeys.insightsAnomalies("24h"), anomalies);
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<InsightsTab />
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}

describe("Insights cost tracking", () => {
	it("hides cached dollar figures and shows the shared notice while keeping token metrics", () => {
		const markup = render(false);
		expect(markup).toContain("Cost tracking is disabled");
		expect(markup).toContain("gap is not backfilled");
		expect(markup).toContain("Cache Hit Rate");
		expect(markup).toContain("Input Token Composition");
		expect(markup).toContain("Token outliers");
		for (const cost of ["$5.10", "$2.10", "$7.20", "$123.45"])
			expect(markup).not.toContain(cost);
	});
	it("shows cache costs and anomaly costs when tracking is enabled", () => {
		const markup = render(true);
		expect(markup).not.toContain("Cost tracking is disabled");
		expect(markup).toContain("$5.10");
		expect(markup).toContain("$123.45");
	});
});
