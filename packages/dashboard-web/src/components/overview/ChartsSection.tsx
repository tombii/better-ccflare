import { useMemo } from "react";
import { formatCost } from "@better-ccflare/ui-common";
import { CHART_COLORS, COLORS } from "../../constants";
import {
	BaseAreaChart,
	BaseBarChart,
	BaseLineChart,
	BasePieChart,
} from "../charts";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	getSortedAccountCostRows,
	getAccountCostTotals,
	hasAnyAccountCostData,
} from "./account-cost-table-utils";

interface ChartsSectionProps {
	timeSeriesData: Array<{
		time: string;
		requests: number;
		successRate: number;
		responseTime: number;
		cost: string;
		planCost: number;
		apiCost: number;
	}>;
	modelData: Array<{ name: string; value: number }>;
	accountHealthData: Array<{
		name: string;
		requests: number;
		successRate: number;
		planCostUsd: number;
		apiCostUsd: number;
		totalCostUsd: number;
	}>;
	accountModelUsageData: Array<{
		account: string;
		model: string;
		count: number;
	}>;
	apiKeyPerformanceData: Array<{
		name: string;
		requests: number;
		successRate: number;
	}>;
	loading: boolean;
}

export function ChartsSection({
	timeSeriesData,
	modelData,
	accountHealthData,
	accountModelUsageData,
	apiKeyPerformanceData,
	loading,
}: ChartsSectionProps) {
	// Aggregate account-model usage into per-account totals for the donut chart
	const accountUsageDonutData = useMemo(() => {
		const totals = new Map<string, number>();
		for (const row of accountModelUsageData) {
			totals.set(row.account, (totals.get(row.account) ?? 0) + row.count);
		}
		return Array.from(totals.entries())
			.map(([name, value]) => ({ name, value }))
			.sort((a, b) => b.value - a.value);
	}, [accountModelUsageData]);

	// Build per-account model breakdown for tooltip
	const accountModelBreakdown = useMemo(() => {
		const breakdown = new Map<
			string,
			Array<{ model: string; count: number }>
		>();
		for (const row of accountModelUsageData) {
			if (!breakdown.has(row.account)) breakdown.set(row.account, []);
			breakdown.get(row.account)?.push({ model: row.model, count: row.count });
		}
		return breakdown;
	}, [accountModelUsageData]);

	// Prepare API key donut data (requests per client API key)
	const apiKeyDonutData = useMemo(() => {
		return apiKeyPerformanceData
			.map((k) => ({ name: k.name, value: k.requests }))
			.sort((a, b) => b.value - a.value);
	}, [apiKeyPerformanceData]);

	const sortedAccountCostRows = useMemo(
		() => getSortedAccountCostRows(accountHealthData),
		[accountHealthData],
	);
	const accountCostTotals = useMemo(
		() => getAccountCostTotals(sortedAccountCostRows),
		[sortedAccountCostRows],
	);
	return (
		<>
			{/* Charts Row 1 */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Request Volume Chart */}
				<Card>
					<CardHeader>
						<CardTitle>Request Volume</CardTitle>
						<CardDescription>
							Requests per hour over the last 24 hours
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BaseAreaChart
							data={timeSeriesData}
							dataKey="requests"
							loading={loading}
							height="medium"
						/>
					</CardContent>
				</Card>

				{/* Success Rate Chart */}
				<Card>
					<CardHeader>
						<CardTitle>Success Rate Trend</CardTitle>
						<CardDescription>Success percentage over time</CardDescription>
					</CardHeader>
					<CardContent>
						<BaseLineChart
							data={timeSeriesData}
							lines={{ dataKey: "successRate", stroke: COLORS.success }}
							loading={loading}
							height="medium"
							yAxisDomain={[80, 100]}
						/>
					</CardContent>
				</Card>
			</div>

			{/* Charts Row 2 — three donut charts */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Model Distribution */}
				<Card>
					<CardHeader>
						<CardTitle>Model Usage</CardTitle>
						<CardDescription>
							Distribution of API calls by model
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BasePieChart
							data={modelData}
							loading={loading}
							height="small"
							innerRadius={60}
							outerRadius={80}
							paddingAngle={5}
							tooltipStyle="success"
						/>
						<div className="mt-4 space-y-2">
							{modelData.map((model, index) => (
								<div
									key={model.name}
									className="flex items-center justify-between text-sm"
								>
									<div className="flex items-center gap-2">
										<div
											className="h-3 w-3 rounded-full"
											style={{
												backgroundColor:
													CHART_COLORS[index % CHART_COLORS.length],
											}}
										/>
										<span className="text-muted-foreground">{model.name}</span>
									</div>
									<span className="font-medium">{model.value}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>

				{/* Usage by Account */}
				<Card>
					<CardHeader>
						<CardTitle>Usage by Account</CardTitle>
						<CardDescription>
							Request distribution across accounts
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BasePieChart
							data={accountUsageDonutData}
							loading={loading}
							height="small"
							innerRadius={60}
							outerRadius={80}
							paddingAngle={5}
							tooltipStyle="success"
						/>
						<div className="mt-4 space-y-2">
							{accountUsageDonutData.map((account, index) => {
								const models = accountModelBreakdown.get(account.name) ?? [];
								return (
									<div key={account.name} className="space-y-1">
										<div className="flex items-center justify-between text-sm">
											<div className="flex items-center gap-2">
												<div
													className="h-3 w-3 rounded-full"
													style={{
														backgroundColor:
															CHART_COLORS[index % CHART_COLORS.length],
													}}
												/>
												<span className="text-muted-foreground font-medium">
													{account.name}
												</span>
											</div>
											<span className="font-medium">{account.value}</span>
										</div>
										{models.length > 1 && (
											<div className="pl-5 space-y-0.5">
												{models.map((m) => (
													<div
														key={m.model}
														className="flex items-center justify-between text-xs text-muted-foreground"
													>
														<span>{m.model}</span>
														<span>{m.count}</span>
													</div>
												))}
											</div>
										)}
									</div>
								);
							})}
						</div>
					</CardContent>
				</Card>

				{/* Usage by Client API Key */}
				<Card>
					<CardHeader>
						<CardTitle>Usage by API Key</CardTitle>
						<CardDescription>
							Request distribution across your client API keys
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BasePieChart
							data={apiKeyDonutData}
							loading={loading}
							height="small"
							innerRadius={60}
							outerRadius={80}
							paddingAngle={5}
							tooltipStyle="success"
						/>
						<div className="mt-4 space-y-2">
							{apiKeyDonutData.map((key, index) => (
								<div
									key={key.name}
									className="flex items-center justify-between text-sm"
								>
									<div className="flex items-center gap-2">
										<div
											className="h-3 w-3 rounded-full"
											style={{
												backgroundColor:
													CHART_COLORS[index % CHART_COLORS.length],
											}}
										/>
										<span className="text-muted-foreground">{key.name}</span>
									</div>
									<span className="font-medium">{key.value}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Charts Row 3 — Account Performance */}
			<div className="grid grid-cols-1 gap-6">
				<Card>
					<CardHeader>
						<CardTitle>Account Performance</CardTitle>
						<CardDescription>
							Request distribution and success rates by account
						</CardDescription>
					</CardHeader>
					<CardContent>
						<BaseBarChart
							data={accountHealthData}
							bars={[
								{ dataKey: "requests", yAxisId: "left", name: "Requests" },
								{
									dataKey: "successRate",
									yAxisId: "right",
									fill: COLORS.success,
									name: "Success %",
								},
							]}
							xAxisKey="name"
							loading={loading}
							height="small"
							secondaryYAxis={true}
							showLegend={true}
						/>
					<div className="mt-4 border rounded-md overflow-hidden">
						<table aria-label="Account cost breakdown" className="w-full text-sm">
							<thead className="bg-muted/50">
								<tr>
									<th scope="col" className="text-left px-3 py-2">Account</th>
									<th scope="col" className="text-right px-3 py-2">Plan Value</th>
									<th scope="col" className="text-right px-3 py-2">API Value</th>
									<th scope="col" className="text-right px-3 py-2">Total</th>
								</tr>
							</thead>
							<tbody>
								{hasAnyAccountCostData(sortedAccountCostRows) ? (
									sortedAccountCostRows.map((row) => (
										<tr key={row.name} className="border-t">
											<td className="px-3 py-2 text-muted-foreground">{row.name}</td>
											<td className="px-3 py-2 text-right">{formatCost(row.planCostUsd)}</td>
											<td className="px-3 py-2 text-right">{formatCost(row.apiCostUsd)}</td>
											<td className="px-3 py-2 text-right font-medium">{formatCost(row.totalCostUsd)}</td>
										</tr>
									))
								) : (
									<tr className="border-t">
										<td className="px-3 py-3 text-muted-foreground" colSpan={4}>
											No cost data
										</td>
									</tr>
								)}
							</tbody>
							<tfoot className="bg-muted/30 border-t">
								<tr>
									<th scope="row" className="px-3 py-2 font-medium text-left">Total</th>
									<td className="px-3 py-2 text-right font-medium">{formatCost(accountCostTotals.planCostUsd)}</td>
									<td className="px-3 py-2 text-right font-medium">{formatCost(accountCostTotals.apiCostUsd)}</td>
									<td className="px-3 py-2 text-right font-medium">{formatCost(accountCostTotals.totalCostUsd)}</td>
								</tr>
							</tfoot>
						</table>
					</div>
				</CardContent>
			</Card>
		</div>
	</>
	);
}
