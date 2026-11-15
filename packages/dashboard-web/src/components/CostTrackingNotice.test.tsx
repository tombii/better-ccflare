import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../api";
import { COST_TRACKING_QUERY_KEY } from "../hooks/useCostTracking";
import { fetchConfigFlag } from "../lib/config-flag-api";
import {
	CumulativeGrowthChart,
	MainMetricsChart,
	ModelComparisonCharts,
} from "./analytics/AnalyticsCharts";
import { ModelAnalytics } from "./analytics/ModelAnalytics";
import { ApiKeySpendGauge } from "./api-keys/ApiKeySpendGauge";
import { CostTrackingNotice } from "./CostTrackingNotice";
import { CostTrackingCard } from "./overview/CostTrackingCard";
import * as TabsUI from "./ui/tabs";

function render(
	enabled: boolean | undefined | Error,
	children: React.ReactNode,
	cachedClient?: QueryClient,
) {
	const client =
		cachedClient ??
		new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	if (enabled instanceof Error) {
		client
			.getQueryCache()
			.build(client, { queryKey: COST_TRACKING_QUERY_KEY })
			.setState({ status: "error", error: enabled });
	} else if (enabled !== undefined) {
		client.setQueryData(COST_TRACKING_QUERY_KEY, { enabled, source: "file" });
	}
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>{children}</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}
describe("cost tracking dashboard", () => {
	it("keeps analytics after the settings request rejects", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const failure = new Error("Settings request failed");
		const request = spyOn(api, "get").mockRejectedValueOnce(failure);
		try {
			await expect(
				client.fetchQuery({
					queryKey: COST_TRACKING_QUERY_KEY,
					queryFn: () => fetchConfigFlag("/api/config/cost-tracking"),
				}),
			).rejects.toBe(failure);
			const html = render(
				undefined,
				<>
					<ModelAnalytics
						modelPerformance={[]}
						costByModel={[]}
						timeRange="24h"
					/>
					<CumulativeGrowthChart data={[]} />
				</>,
				client,
			);
			expect(request).toHaveBeenCalledWith("/api/config/cost-tracking");
			expect(html).toContain("Model Performance Analytics");
			expect(html).toContain("Response time and error rate analysis");
			expect(html).toContain("Token usage over time");
			expect(html).not.toContain("Token generation speed vs. cost efficiency");
		} finally {
			request.mockRestore();
			client.clear();
		}
	});

	it("shows neither costs nor a disabled warning while tracking loads", () => {
		expect(render(undefined, <CostTrackingNotice limits />)).toBe("");
		const html = render(
			undefined,
			<ApiKeySpendGauge
				apiKey={{
					id: "key",
					name: "budget",
					limitWindowMode: "calendar",
					limits: [
						{
							id: "limit",
							apiKeyId: "key",
							scopeModel: null,
							window: "day",
							limitUsd: 100,
							enforce: "block",
							spentUsd: 456.789,
						},
					],
				}}
			/>,
		);
		expect(html).not.toContain("456.789");
		expect(html).not.toContain("Cost tracking is disabled");
	});
	it("shows a clear limit warning only while disabled", () => {
		expect(render(true, <CostTrackingNotice limits />)).toBe("");
		const html = render(false, <CostTrackingNotice limits />);
		expect(html).toContain("Cost tracking is disabled");
		expect(html).toContain("Spend limits are not enforced");
		expect(html).toContain("gap is not backfilled");
	});
	it("hides stale gauge costs and replaces them with the warning", () => {
		const html = render(
			false,
			<ApiKeySpendGauge
				apiKey={{
					id: "key",
					name: "budget",
					limits: [
						{
							id: "limit",
							apiKeyId: "key",
							scopeModel: null,
							window: "day",
							limitUsd: 100,
							enforce: "block",
							spentUsd: 456.789,
						},
					],
					limitWindowMode: "calendar",
				}}
			/>,
		);
		expect(html).toContain("Cost tracking is disabled");
		expect(html).not.toContain("456.789");
	});
	it("keeps the cost setting off and documents NULL/no backfill", () => {
		const html = render(false, <CostTrackingCard />);
		expect(html).toContain('aria-checked="false"');
		expect(html).toContain("NULL");
		expect(html).toContain("gap is not backfilled");
	});
	it("replaces a selected analytics cost chart with a disabled notice", () => {
		const html = render(
			false,
			<MainMetricsChart
				data={[]}
				loading={false}
				viewMode="normal"
				timeRange="24h"
				selectedMetric="cost"
				setSelectedMetric={() => {}}
			/>,
		);
		expect(html).toContain("Cost tracking is disabled");
		expect(html).not.toContain("recharts-wrapper");
	});
	it("shows performance while tracking loads and cost comparison only when enabled", () => {
		const chart = (
			<ModelAnalytics modelPerformance={[]} costByModel={[]} timeRange="24h" />
		);
		expect(render(undefined, chart)).toContain(
			"Response time and error rate analysis",
		);
		expect(render(false, chart)).toContain(
			"Response time and error rate analysis",
		);
		expect(render(true, chart)).toContain(
			"Token generation speed vs. cost efficiency",
		);
	});
	it("waits for tracking before selecting cost chart content", () => {
		const chart = (
			<MainMetricsChart
				data={[]}
				loading={false}
				viewMode="normal"
				timeRange="24h"
				selectedMetric="cost"
				setSelectedMetric={() => {}}
			/>
		);
		const pending = render(undefined, chart);
		expect(pending).not.toContain("Cost tracking is disabled");
		expect(pending).not.toContain("recharts-responsive-container");
		expect(render(true, chart)).toContain("recharts-responsive-container");
	});
	it("keeps cumulative token content while tracking loads", () => {
		const chart = <CumulativeGrowthChart data={[]} />;
		expect(render(undefined, chart)).toContain("Token usage over time");
		expect(render(false, chart)).toContain("Token usage over time");
		expect(render(true, chart)).toContain(
			"Token usage vs. cost accumulation over time",
		);
	});
	for (const [state, enabled] of [
		["pending", undefined],
		["failed", new Error("Settings request failed")],
		["enabled", true],
		["disabled", false],
	] as const) {
		it(`keeps model speed and reliability with ${state} cost tracking`, () => {
			// Mount both real tab panels to verify detailed content as well as the
			// default comparison panel without replacing either chart component.
			const original = TabsUI.TabsContent;
			const panels = spyOn(TabsUI, "TabsContent").mockImplementation((props) =>
				createElement(original, { ...props, forceMount: true }),
			);
			try {
				const html = render(
					enabled,
					<ModelAnalytics
						modelPerformance={[
							{
								model: "test-model",
								avgResponseTime: 10,
								p95ResponseTime: 20,
								errorRate: 0,
								avgTokensPerSecond: 30,
								minTokensPerSecond: 20,
								maxTokensPerSecond: 40,
							},
						]}
						costByModel={[{ model: "test-model", costUsd: 1, requests: 1 }]}
						timeRange="24h"
					/>,
				);
				for (const text of [
					"Model Performance Analytics",
					"Token Generation Speed",
					"Fastest Model",
					"Most Reliable Model",
				])
					expect(html).toContain(text);
				if (enabled === true) {
					expect(html).toContain("Token generation speed vs. cost efficiency");
					expect(html).toContain("Most Cost-Effective");
				} else {
					expect(html).toContain("Response time and error rate analysis");
					expect(html).not.toContain("Most Cost-Effective");
					expect(html).not.toContain("Cost/1K");
				}
			} finally {
				panels.mockRestore();
			}
		});
		it(`keeps non-cost analytics charts with ${state} cost tracking`, () => {
			const html = render(
				enabled,
				<>
					<MainMetricsChart
						data={[]}
						loading={false}
						viewMode="normal"
						timeRange="24h"
						selectedMetric="requests"
						setSelectedMetric={() => {}}
					/>
					<ModelComparisonCharts
						modelPerformance={[]}
						costByModel={[]}
						loading={false}
						timeRange="24h"
					/>
					<CumulativeGrowthChart data={[]} />
				</>,
			);
			for (const text of [
				"Traffic Analytics",
				"Model Performance Comparison",
				"Cumulative Growth Analysis",
			])
				expect(html).toContain(text);
			if (enabled === true) {
				expect(html).toContain("Cost Analysis by Model");
				expect(html).toContain("Token usage vs. cost accumulation over time");
			} else {
				expect(html).not.toContain("Cost Analysis by Model");
				expect(html).toContain("Token usage over time");
			}
			const selectedCost = render(
				enabled,
				<MainMetricsChart
					data={[]}
					loading={false}
					viewMode="normal"
					timeRange="24h"
					selectedMetric="cost"
					setSelectedMetric={() => {}}
				/>,
			);
			expect(selectedCost).toContain("Traffic Analytics");
			if (enabled === true)
				expect(selectedCost).toContain("recharts-responsive-container");
			else expect(selectedCost).not.toContain("recharts-responsive-container");
		});
	}
});
