import { format } from "date-fns";
import { CalendarDays, Download, Filter, RefreshCw } from "lucide-react";
import { useState } from "react";
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

	// Generate mock data based on time range
	const generateTimeSeriesData = () => {
		const now = new Date();
		let points = 24;
		let interval = 60 * 60 * 1000; // 1 hour

		switch (timeRange) {
			case "1h":
				points = 60;
				interval = 60 * 1000; // 1 minute
				break;
			case "6h":
				points = 72;
				interval = 5 * 60 * 1000; // 5 minutes
				break;
			case "24h":
				points = 24;
				interval = 60 * 60 * 1000; // 1 hour
				break;
			case "7d":
				points = 168;
				interval = 60 * 60 * 1000; // 1 hour
				break;
			case "30d":
				points = 30;
				interval = 24 * 60 * 60 * 1000; // 1 day
				break;
		}

		return Array.from({ length: points }, (_, i) => {
			const time = new Date(now.getTime() - (points - 1 - i) * interval);
			const baseRequests = 1000 + Math.sin(i / 10) * 500;
			return {
				time:
					timeRange === "30d" ? format(time, "MMM d") : format(time, "HH:mm"),
				requests: Math.floor(baseRequests + Math.random() * 200),
				tokens: Math.floor(baseRequests * 150 + Math.random() * 10000),
				cost: (baseRequests * 0.001 + Math.random() * 0.5).toFixed(2),
				responseTime: Math.floor(
					50 + Math.sin(i / 5) * 30 + Math.random() * 20,
				),
				errorRate: (Math.random() * 5).toFixed(1),
				cacheHitRate: (85 + Math.random() * 10).toFixed(1),
			};
		});
	};

	const data = generateTimeSeriesData();

	// Generate token usage breakdown
	const tokenBreakdown = [
		{ type: "Input Tokens", value: 45000, percentage: 30 },
		{ type: "Cache Read", value: 60000, percentage: 40 },
		{ type: "Cache Creation", value: 15000, percentage: 10 },
		{ type: "Output Tokens", value: 30000, percentage: 20 },
	];

	// Generate model performance data
	const modelPerformance = [
		{ model: "claude-3-opus", avgTime: 850, p95Time: 1200, errorRate: 0.5 },
		{ model: "claude-3.5-sonnet", avgTime: 420, p95Time: 650, errorRate: 0.8 },
		{ model: "claude-3-haiku", avgTime: 180, p95Time: 280, errorRate: 1.2 },
	];

	// Cost analysis data
	const costByEndpoint = [
		{ endpoint: "/v1/messages", cost: 124.5, requests: 15420 },
		{ endpoint: "/v1/completions", cost: 87.3, requests: 8920 },
		{ endpoint: "/v1/chat", cost: 56.2, requests: 6230 },
		{ endpoint: "/v1/embeddings", cost: 12.8, requests: 3410 },
	];

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
					<Button variant="outline" size="sm">
						<RefreshCw className="h-4 w-4 mr-2" />
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
