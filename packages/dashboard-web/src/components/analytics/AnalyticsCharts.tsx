import { formatCost, formatNumber, formatTokens } from "@claudeflare/ui-common";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import {
	CHART_HEIGHTS,
	CHART_PROPS,
	COLORS,
	type TimeRange,
} from "../../constants";
import {
	BaseAreaChart,
	BaseBarChart,
	BaseLineChart,
	CostChart,
	ModelPerformanceChart,
	RequestVolumeChart,
	ResponseTimeChart,
	TokenUsageChart,
} from "../charts";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface ChartData {
	time: string;
	requests: number;
	tokens: number;
	cost: number;
	responseTime: number;
	errorRate: number;
	cacheHitRate: number;
}

interface MainMetricsChartProps {
	data: ChartData[];
	loading: boolean;
	viewMode: "normal" | "cumulative";
	timeRange: TimeRange;
	selectedMetric: string;
	setSelectedMetric: (metric: string) => void;
}

export function MainMetricsChart({
	data,
	loading,
	viewMode,
	timeRange,
	selectedMetric,
	setSelectedMetric,
}: MainMetricsChartProps) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle>Traffic Analytics</CardTitle>
						<CardDescription>
							{viewMode === "cumulative"
								? "Cumulative totals showing growth over time"
								: "Request volume and performance metrics over time"}
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
				{selectedMetric === "tokens" ? (
					<TokenUsageChart
						data={data}
						loading={loading}
						height={CHART_HEIGHTS.large}
						viewMode={viewMode}
						timeRange={timeRange}
					/>
				) : selectedMetric === "cost" ? (
					<CostChart
						data={data}
						loading={loading}
						height={CHART_HEIGHTS.large}
						viewMode={viewMode}
						timeRange={timeRange}
					/>
				) : selectedMetric === "requests" ? (
					<RequestVolumeChart
						data={data}
						loading={loading}
						height={CHART_HEIGHTS.large}
						viewMode={viewMode}
						timeRange={timeRange}
					/>
				) : selectedMetric === "responseTime" ? (
					<ResponseTimeChart
						data={data}
						loading={loading}
						height={CHART_HEIGHTS.large}
						viewMode={viewMode}
						timeRange={timeRange}
					/>
				) : (
					<BaseAreaChart
						data={data}
						dataKey={selectedMetric}
						loading={loading}
						height="large"
						color={viewMode === "cumulative" ? COLORS.purple : COLORS.primary}
						strokeWidth={viewMode === "cumulative" ? 3 : 2}
						xAxisAngle={timeRange === "7d" || timeRange === "30d" ? -45 : 0}
						xAxisTextAnchor={
							timeRange === "7d" || timeRange === "30d" ? "end" : "middle"
						}
						xAxisHeight={timeRange === "7d" || timeRange === "30d" ? 60 : 30}
						tooltipLabelFormatter={(label) =>
							viewMode === "cumulative" ? `Cumulative at ${label}` : label
						}
					/>
				)}
			</CardContent>
		</Card>
	);
}

interface PerformanceIndicatorsChartProps {
	data: ChartData[];
	loading: boolean;
}

export function PerformanceIndicatorsChart({
	data,
	loading,
}: PerformanceIndicatorsChartProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Performance Indicators</CardTitle>
				<CardDescription>Error rate and cache hit rate trends</CardDescription>
			</CardHeader>
			<CardContent>
				<BaseLineChart
					data={data}
					lines={[
						{
							dataKey: "errorRate",
							stroke: COLORS.error,
							name: "Error Rate %",
						},
						{
							dataKey: "cacheHitRate",
							stroke: COLORS.success,
							name: "Cache Hit %",
						},
					]}
					loading={loading}
					height="medium"
					showLegend={true}
					referenceLines={[
						{ y: 90, stroke: COLORS.success },
						{ y: 5, stroke: COLORS.error },
					]}
				/>
			</CardContent>
		</Card>
	);
}

interface TokenBreakdownItem {
	type: string;
	value: number;
	percentage: number;
}

interface TokenUsageBreakdownProps {
	tokenBreakdown: TokenBreakdownItem[];
	timeRange: TimeRange;
}

export function TokenUsageBreakdown({
	tokenBreakdown,
	timeRange,
}: TokenUsageBreakdownProps) {
	return (
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
										{formatTokens(item.value)} tokens
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
								{tokenBreakdown.reduce((acc, item) => acc + item.value, 0)}
							</span>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

interface ModelComparisonChartsProps {
	modelPerformance: Array<{
		model: string;
		avgTime: number;
		p95Time: number;
		errorRate: number;
	}>;
	costByModel: Array<{ model: string; cost: number; requests: number }>;
	loading: boolean;
	timeRange: TimeRange;
}

export function ModelComparisonCharts({
	modelPerformance,
	costByModel,
	loading,
	timeRange,
}: ModelComparisonChartsProps) {
	return (
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
					<ModelPerformanceChart
						data={modelPerformance}
						loading={loading}
						height={CHART_HEIGHTS.medium}
					/>
				</CardContent>
			</Card>

			{/* Cost by Model */}
			<Card>
				<CardHeader>
					<CardTitle>Cost Analysis by Model</CardTitle>
					<CardDescription>
						Top models by cost in the last {timeRange}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<BaseBarChart
						data={costByModel}
						bars={{ dataKey: "cost", radius: [0, 4, 4, 0] }}
						xAxisKey="model"
						loading={loading}
						height="medium"
						layout="vertical"
						yAxisWidth={120}
						tooltipFormatter={(value, name) => {
							if (name === "cost") return [formatCost(Number(value)), "Cost"];
							return [formatNumber(value as number), "Requests"];
						}}
					/>
				</CardContent>
			</Card>
		</div>
	);
}

interface CumulativeGrowthChartProps {
	data: ChartData[];
}

export function CumulativeGrowthChart({ data }: CumulativeGrowthChartProps) {
	return (
		<Card className="bg-gradient-to-br from-background to-muted/10 border-muted">
			<CardHeader>
				<CardTitle className="text-2xl font-bold">
					Cumulative Growth Analysis
				</CardTitle>
				<CardDescription>
					Token usage vs. cost accumulation over time
				</CardDescription>
			</CardHeader>
			<CardContent>
				<ResponsiveContainer width="100%" height={CHART_HEIGHTS.large}>
					<AreaChart
						data={data}
						margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
					>
						<defs>
							<linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor={COLORS.blue} stopOpacity={0.9} />
								<stop offset="100%" stopColor={COLORS.blue} stopOpacity={0.1} />
							</linearGradient>
							<linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={COLORS.warning}
									stopOpacity={0.9}
								/>
								<stop
									offset="100%"
									stopColor={COLORS.warning}
									stopOpacity={0.1}
								/>
							</linearGradient>
							<filter id="glow">
								<feGaussianBlur stdDeviation="4" result="coloredBlur" />
								<feMerge>
									<feMergeNode in="coloredBlur" />
									<feMergeNode in="SourceGraphic" />
								</feMerge>
							</filter>
						</defs>
						<CartesianGrid
							strokeDasharray={CHART_PROPS.strokeDasharray}
							stroke="rgba(255,255,255,0.1)"
						/>
						<XAxis
							dataKey="time"
							className="text-xs"
							stroke="rgba(255,255,255,0.5)"
						/>
						<YAxis yAxisId="tokens" className="text-xs" stroke={COLORS.blue} />
						<YAxis
							yAxisId="cost"
							orientation="right"
							className="text-xs"
							stroke={COLORS.warning}
						/>
						<Tooltip
							labelClassName="font-bold"
							contentStyle={{
								backgroundColor: "rgba(0,0,0,0.8)",
								border: "1px solid rgba(255,255,255,0.2)",
								borderRadius: "8px",
								backdropFilter: "blur(8px)",
							}}
							formatter={(value: number | string, name: string) => {
								if (name === "Total Cost")
									return [formatCost(Number(value)), "Total Cost"];
								return [formatTokens(value as number), "Total Tokens"];
							}}
						/>
						<Legend
							verticalAlign="top"
							height={36}
							iconType="rect"
							wrapperStyle={{
								paddingBottom: "20px",
							}}
						/>
						<Area
							yAxisId="tokens"
							type="monotone"
							dataKey="tokens"
							stroke={COLORS.blue}
							strokeWidth={3}
							fillOpacity={1}
							fill="url(#colorTokens)"
							filter="url(#glow)"
							name="Total Tokens"
						/>
						<Area
							yAxisId="cost"
							type="monotone"
							dataKey="cost"
							stroke={COLORS.warning}
							strokeWidth={3}
							fillOpacity={1}
							fill="url(#colorCost)"
							filter="url(#glow)"
							name="Total Cost"
						/>
					</AreaChart>
				</ResponsiveContainer>
			</CardContent>
		</Card>
	);
}

interface CumulativeTokenCompositionProps {
	tokenBreakdown: TokenBreakdownItem[];
}

export function CumulativeTokenComposition({
	tokenBreakdown,
}: CumulativeTokenCompositionProps) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Cumulative Token Composition</CardTitle>
				<CardDescription>Token type distribution over time</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-6">
					<div className="relative h-24 bg-muted rounded-lg overflow-hidden">
						{(() => {
							let offset = 0;
							return tokenBreakdown.map((item, index) => {
								const width = item.percentage;
								const currentOffset = offset;
								offset += width;
								return (
									<div
										key={item.type}
										className="absolute h-full transition-all duration-1000 hover:opacity-80"
										style={{
											left: `${currentOffset}%`,
											width: `${width}%`,
											background: `linear-gradient(135deg, ${
												index === 0
													? COLORS.blue
													: index === 1
														? COLORS.success
														: index === 2
															? COLORS.warning
															: COLORS.purple
											} 0%, ${
												index === 0
													? COLORS.purple
													: index === 1
														? COLORS.blue
														: index === 2
															? COLORS.primary
															: COLORS.warning
											} 100%)`,
										}}
									>
										<div className="flex items-center justify-center h-full">
											{width > 10 && (
												<span className="text-white font-medium text-xs">
													{item.percentage}%
												</span>
											)}
										</div>
									</div>
								);
							});
						})()}
					</div>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
						{tokenBreakdown.map((item, index) => (
							<div key={item.type} className="flex items-center gap-2">
								<div
									className="w-3 h-3 rounded-full"
									style={{
										background:
											index === 0
												? COLORS.blue
												: index === 1
													? COLORS.success
													: index === 2
														? COLORS.warning
														: COLORS.purple,
									}}
								/>
								<div>
									<p className="text-xs text-muted-foreground">{item.type}</p>
									<p className="text-sm font-medium">
										{formatTokens(item.value)}
									</p>
								</div>
							</div>
						))}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
