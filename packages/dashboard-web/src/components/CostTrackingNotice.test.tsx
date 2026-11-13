import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { COST_TRACKING_QUERY_KEY } from "../hooks/useCostTracking";
import { MainMetricsChart } from "./analytics/AnalyticsCharts";
import { ApiKeySpendGauge } from "./api-keys/ApiKeySpendGauge";
import { CostTrackingNotice } from "./CostTrackingNotice";
import { CostTrackingCard } from "./overview/CostTrackingCard";

function render(enabled: boolean, children: React.ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
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
});
