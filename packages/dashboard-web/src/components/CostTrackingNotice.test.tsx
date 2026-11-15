import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { COST_TRACKING_QUERY_KEY } from "../hooks/useCostTracking";
import {
	CumulativeGrowthChart,
	MainMetricsChart,
} from "./analytics/AnalyticsCharts";
import { ModelAnalytics } from "./analytics/ModelAnalytics";
import { ApiKeySpendGauge } from "./api-keys/ApiKeySpendGauge";
import { CostTrackingNotice } from "./CostTrackingNotice";
import { CostTrackingCard } from "./overview/CostTrackingCard";

function render(enabled: boolean | undefined, children: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	if (enabled !== undefined)
		client.setQueryData(COST_TRACKING_QUERY_KEY, { enabled, source: "file" });
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>{children}</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}
describe("cost tracking dashboard", () => {
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
	it("waits for tracking before choosing a model comparison view", () => {
		const chart = (
			<ModelAnalytics modelPerformance={[]} costByModel={[]} timeRange="24h" />
		);
		expect(render(undefined, chart)).toBe("");
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
	it("does not show a token-only description while cumulative costs load", () => {
		const chart = <CumulativeGrowthChart data={[]} />;
		expect(render(undefined, chart)).not.toContain("Token usage over time");
		expect(render(false, chart)).toContain("Token usage over time");
		expect(render(true, chart)).toContain(
			"Token usage vs. cost accumulation over time",
		);
	});
});
