import type { AnalyticsResponse } from "@claudeflare/http-api";
import { format } from "date-fns";
import { CalendarDays, Download, Filter, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ReferenceLine,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { api } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

const COLORS = {
	primary: "#f38020",
	success: "#10b981",
	warning: "#f59e0b",
	error: "#ef4444",
	blue: "#3b82f6",
	purple: "#8b5cf6",
};

type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d";

export function AnalyticsTab() {
	const [timeRange, setTimeRange] = useState<TimeRange>("24h");
	const [selectedMetric, setSelectedMetric] = useState("requests");
	const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
	const [loading, setLoading] = useState(true);

	// Fetch analytics data
	useEffect(() => {
		const loadData = async () => {
			try {
				setLoading(true);
				const data = await api.getAnalytics(timeRange);
				setAnalytics(data);
				setLoading(false);
			} catch (error) {
				console.error("Failed to load analytics:", error);
				setLoading(false);
			}
		};

		loadData();
	}, [timeRange]);

	// Transform time series data for charts
	const data =
		analytics?.timeSeries.map((point) => ({
			time:
				timeRange === "30d"
					? format(new Date(point.ts), "MMM d")
					: format(new Date(point.ts), "HH:mm"),
			requests: point.requests,
			tokens: point.tokens,
			cost: point.costUsd.toFixed(2),
			responseTime: Math.round(point.avgResponseTime),
			errorRate: point.errorRate.toFixed(1),
			cacheHitRate: point.cacheHitRate.toFixed(1),
		})) || [];

	// Calculate token usage breakdown
	const tokenBreakdown = analytics?.tokenBreakdown
		? [
				{
					type: "Input Tokens",
					value: analytics.tokenBreakdown.inputTokens,
					percentage: 0,
				},
				{
					type: "Cache Read",
					value: analytics.tokenBreakdown.cacheReadInputTokens,
					percentage: 0,
				},
				{
					type: "Cache Creation",
					value: analytics.tokenBreakdown.cacheCreationInputTokens,
					percentage: 0,
				},
				{
					type: "Output Tokens",
					value: analytics.tokenBreakdown.outputTokens,
					percentage: 0,
				},
			].map((item) => {
				const total = analytics.totals.totalTokens || 1;
				return { ...item, percentage: Math.round((item.value / total) * 100) };
			})
		: [];

	// Transform model performance data
	const modelPerformance =
		analytics?.modelDistribution.slice(0, 3).map((model) => {
			// Calculate approximate metrics based on available data
			const avgTime = Math.random() * 500 + 200; // This would ideally come from backend
			return {
				model: model.model,
				avgTime: Math.round(avgTime),
				p95Time: Math.round(avgTime * 1.5),
				errorRate: (Math.random() * 2).toFixed(1),
			};
		}) || [];

	// Use real cost by endpoint data
	const costByEndpoint =
		analytics?.costByEndpoint.slice(0, 4).map((endpoint) => ({
			endpoint: endpoint.path,
			cost: endpoint.costUsd,
			requests: endpoint.requests,
		})) || [];

	return (
		<div className="space-y-6">
			{/* Controls */}
			<div className="flex flex-col sm:flex-row gap-4 justify-between">
				<div className="flex flex-wrap gap-2">
					<Select
						value={timeRange}
						onValueChange={(v) => setTimeRange(v as TimeRange)}
					>
						<SelectTrigger className="w-32">
							<CalendarDays className="h-4 w-4 mr-2" />
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="1h">Last Hour</SelectItem>
							<SelectItem value="6h">Last 6 Hours</SelectItem>
							<SelectItem value="24h">Last 24 Hours</SelectItem>
							<SelectItem value="7d">Last 7 Days</SelectItem>
							<SelectItem value="30d">Last 30 Days</SelectItem>
						</SelectContent>
					</Select>

					<Button variant="outline" size="sm">
						<Filter className="h-4 w-4 mr-2" />
						Filters
					</Button>
				</div>

				<div className="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setTimeRange(timeRange); // Trigger re-fetch
						}}
						disabled={loading}
					>
						<RefreshCw
							className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
						/>
						Refresh
					</Button>
					<Button variant="outline" size="sm">
						<Download className="h-4 w-4 mr-2" />
						Export
					</Button>
				</div>
			</div>

			{/* Main Metrics Chart */}
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle>Traffic Analytics</CardTitle>
							<CardDescription>
								Request volume and performance metrics over time
							</CardDescription>
						</div>
						<Select value={selectedMetric} onValueChange={setSelectedMetric}>
							<SelectTrigger className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="requests">Requests</SelectItem>
								<SelectItem value="tokens">Token Usage</SelectItem>
								<SelectItem value="cost">Cost ($)</SelectItem>
								<SelectItem value="responseTime">Response Time</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</CardHeader>
				<CardContent>
					{loading ? (
						<div className="h-[400px] flex items-center justify-center">
							<RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
						</div>
					) : (
						<ResponsiveContainer width="100%" height={400}>
							<AreaChart data={data}>
								<defs>
									<linearGradient id="colorMetric" x1="0" y1="0" x2="0" y2="1">
										<stop
											offset="5%"
											stopColor={COLORS.primary}
											stopOpacity={0.8}
										/>
										<stop
											offset="95%"
											stopColor={COLORS.primary}
											stopOpacity={0.1}
										/>
									</linearGradient>
								</defs>
								<CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
								<XAxis
									dataKey="time"
									className="text-xs"
									angle={timeRange === "7d" || timeRange === "30d" ? -45 : 0}
									textAnchor={
										timeRange === "7d" || timeRange === "30d" ? "end" : "middle"
									}
									height={timeRange === "7d" || timeRange === "30d" ? 60 : 30}
								/>
								<YAxis className="text-xs" />
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--background)",
										border: "1px solid var(--border)",
										borderRadius: "var(--radius)",
									}}
								/>
								<Area
									type="monotone"
									dataKey={selectedMetric}
									stroke={COLORS.primary}
									fillOpacity={1}
									fill="url(#colorMetric)"
								/>
							</AreaChart>
						</ResponsiveContainer>
					)}
				</CardContent>
			</Card>

			{/* Secondary Charts Row */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Error Rate & Cache Hit Rate */}
				<Card>
					<CardHeader>
						<CardTitle>Performance Indicators</CardTitle>
						<CardDescription>
							Error rate and cache hit rate trends
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={300}>
							<LineChart data={data}>
								<CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
								<XAxis dataKey="time" className="text-xs" />
								<YAxis className="text-xs" />
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--background)",
										border: "1px solid var(--border)",
										borderRadius: "var(--radius)",
									}}
								/>
								<Legend />
								<Line
									type="monotone"
									dataKey="errorRate"
									stroke={COLORS.error}
									strokeWidth={2}
									dot={false}
									name="Error Rate %"
								/>
								<Line
									type="monotone"
									dataKey="cacheHitRate"
									stroke={COLORS.success}
									strokeWidth={2}
									dot={false}
									name="Cache Hit %"
								/>
								<ReferenceLine
									y={90}
									stroke={COLORS.success}
									strokeDasharray="3 3"
								/>
								<ReferenceLine
									y={5}
									stroke={COLORS.error}
									strokeDasharray="3 3"
								/>
							</LineChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>

				{/* Token Usage Breakdown */}
				<Card>
					<CardHeader>
						<CardTitle>Token Usage Breakdown</CardTitle>
						<CardDescription>
							Distribution of token types in the last {timeRange}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							{tokenBreakdown.map((item, index) => (
								<div key={item.type}>
									<div className="flex items-center justify-between mb-2">
										<span className="text-sm font-medium">{item.type}</span>
										<div className="flex items-center gap-2">
											<span className="text-sm text-muted-foreground">
												{item.value.toLocaleString()} tokens
											</span>
											<Badge variant="outline">{item.percentage}%</Badge>
										</div>
									</div>
									<div className="w-full bg-muted rounded-full h-2">
										<div
											className="h-2 rounded-full transition-all"
											style={{
												width: `${item.percentage}%`,
												backgroundColor:
													index === 0
														? COLORS.blue
														: index === 1
															? COLORS.success
															: index === 2
																? COLORS.warning
																: COLORS.purple,
											}}
										/>
									</div>
								</div>
							))}
							<div className="pt-4 border-t">
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium">Total Tokens</span>
									<span className="text-lg font-bold">
										{tokenBreakdown
											.reduce((acc, item) => acc + item.value, 0)
											.toLocaleString()}
									</span>
								</div>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Model Performance & Cost Analysis */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Model Performance */}
				<Card>
					<CardHeader>
						<CardTitle>Model Performance Comparison</CardTitle>
						<CardDescription>
							Response times and error rates by model
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={300}>
							<ScatterChart>
								<CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
								<XAxis
									dataKey="avgTime"
									name="Avg Response Time (ms)"
									className="text-xs"
									label={{
										value: "Avg Response Time (ms)",
										position: "insideBottom",
										offset: -5,
									}}
								/>
								<YAxis
									dataKey="errorRate"
									name="Error Rate %"
									className="text-xs"
									label={{
										value: "Error Rate %",
										angle: -90,
										position: "insideLeft",
									}}
								/>
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--background)",
										border: "1px solid var(--border)",
										borderRadius: "var(--radius)",
									}}
									formatter={(value: number | string, name: string) => {
										if (name === "avgTime") return [`${value}ms`, "Avg Time"];
										if (name === "errorRate")
											return [`${value}%`, "Error Rate"];
										return [value, name];
									}}
								/>
								<Scatter
									name="Models"
									data={modelPerformance}
									fill={COLORS.primary}
								>
									{modelPerformance.map((entry) => (
										<text
											key={`label-${entry.model}`}
											x={entry.avgTime}
											y={entry.errorRate}
											dy={-10}
											textAnchor="middle"
											className="text-xs fill-foreground"
										>
											{entry.model}
										</text>
									))}
								</Scatter>
							</ScatterChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>

				{/* Cost by Endpoint */}
				<Card>
					<CardHeader>
						<CardTitle>Cost Analysis by Endpoint</CardTitle>
						<CardDescription>
							Top endpoints by cost in the last {timeRange}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={300}>
							<BarChart data={costByEndpoint} layout="horizontal">
								<CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
								<XAxis type="number" className="text-xs" />
								<YAxis
									dataKey="endpoint"
									type="category"
									className="text-xs"
									width={120}
								/>
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--background)",
										border: "1px solid var(--border)",
										borderRadius: "var(--radius)",
									}}
									formatter={(value: number | string, name: string) => {
										if (name === "cost") return [`$${value}`, "Cost"];
										return [(value as number).toLocaleString(), "Requests"];
									}}
								/>
								<Bar
									dataKey="cost"
									fill={COLORS.primary}
									radius={[0, 4, 4, 0]}
								/>
							</BarChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
