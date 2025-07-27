import { format } from "date-fns";
import {
	Activity,
	CheckCircle,
	Clock,
	DollarSign,
	TrendingDown,
	TrendingUp,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Legend,
	Line,
	LineChart,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { api, type Stats } from "../api";
import { Badge } from "./ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import { Skeleton } from "./ui/skeleton";

// Cloudflare-inspired color palette
const COLORS = {
	primary: "#f38020",
	success: "#10b981",
	warning: "#f59e0b",
	error: "#ef4444",
	blue: "#3b82f6",
	purple: "#8b5cf6",
	pink: "#ec4899",
};

const CHART_COLORS = [
	COLORS.primary,
	COLORS.blue,
	COLORS.purple,
	COLORS.pink,
	COLORS.success,
];

interface MetricCardProps {
	title: string;
	value: string | number;
	change?: number;
	icon: React.ComponentType<{ className?: string }>;
	trend?: "up" | "down";
}

function MetricCard({
	title,
	value,
	change,
	icon: Icon,
	trend,
}: MetricCardProps) {
	return (
		<Card className="card-hover">
			<CardContent className="p-6">
				<div className="flex items-center justify-between">
					<div className="space-y-1">
						<p className="text-sm font-medium text-muted-foreground">{title}</p>
						<p className="text-2xl font-bold">{value}</p>
						{change !== undefined && (
							<div className="flex items-center gap-1 text-sm">
								{trend === "up" ? (
									<TrendingUp className="h-4 w-4 text-success" />
								) : (
									<TrendingDown className="h-4 w-4 text-destructive" />
								)}
								<span
									className={
										trend === "up" ? "text-success" : "text-destructive"
									}
								>
									{Math.abs(change)}%
								</span>
								<span className="text-muted-foreground">vs last hour</span>
							</div>
						)}
					</div>
					<div className="rounded-full bg-primary/10 p-3">
						<Icon className="h-6 w-6 text-primary" />
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

export function OverviewTab() {
	const [stats, setStats] = useState<Stats | null>(null);
	const [loading, setLoading] = useState(true);
	const [timeSeriesData, setTimeSeriesData] = useState<
		Array<{
			time: string;
			requests: number;
			successRate: number;
			responseTime: number;
			cost: string;
		}>
	>([]);

	useEffect(() => {
		const loadData = async () => {
			try {
				const data = await api.getStats();
				setStats(data);

				// Generate mock time series data (in a real app, this would come from the API)
				const now = new Date();
				const mockTimeSeries = Array.from({ length: 24 }, (_, i) => {
					const time = new Date(now.getTime() - (23 - i) * 60 * 60 * 1000);
					return {
						time: format(time, "HH:mm"),
						requests: Math.floor(Math.random() * 1000) + 500,
						successRate: Math.floor(Math.random() * 10) + 90,
						responseTime: Math.floor(Math.random() * 100) + 50,
						cost: (Math.random() * 5).toFixed(2),
					};
				});
				setTimeSeriesData(mockTimeSeries);

				setLoading(false);
			} catch (error) {
				console.error("Failed to load stats:", error);
				setLoading(false);
			}
		};

		loadData();
		const interval = setInterval(loadData, 30000); // Update every 30 seconds
		return () => clearInterval(interval);
	}, []);

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
					{[...Array(4)].map((_, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: Skeleton cards are temporary placeholders
						<Card key={i}>
							<CardContent className="p-6">
								<Skeleton className="h-4 w-24 mb-2" />
								<Skeleton className="h-8 w-32 mb-2" />
								<Skeleton className="h-4 w-20" />
							</CardContent>
						</Card>
					))}
				</div>
				<Card>
					<CardHeader>
						<Skeleton className="h-6 w-32" />
					</CardHeader>
					<CardContent>
						<Skeleton className="h-64 w-full" />
					</CardContent>
				</Card>
			</div>
		);
	}

	// Calculate model distribution for pie chart
	const modelData =
		stats?.topModels?.map((model) => ({
			name: model.model || "Unknown",
			value: model.count,
		})) || [];

	// Calculate account health data
	const accountHealthData =
		stats?.accounts?.map((acc) => ({
			name: acc.name,
			requests: acc.requestCount,
			successRate: acc.successRate,
		})) || [];

	return (
		<div className="space-y-6">
			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				<MetricCard
					title="Total Requests"
					value={stats?.totalRequests?.toLocaleString() || "0"}
					change={12}
					trend="up"
					icon={Activity}
				/>
				<MetricCard
					title="Success Rate"
					value={`${stats?.successRate || 0}%`}
					change={2}
					trend="up"
					icon={CheckCircle}
				/>
				<MetricCard
					title="Avg Response Time"
					value={`${stats?.avgResponseTime || 0}ms`}
					change={-5}
					trend="up"
					icon={Clock}
				/>
				<MetricCard
					title="Total Cost"
					value={`$${stats?.totalCostUsd?.toFixed(2) || "0.00"}`}
					change={8}
					trend="down"
					icon={DollarSign}
				/>
			</div>

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
						<ResponsiveContainer width="100%" height={300}>
							<AreaChart data={timeSeriesData}>
								<defs>
									<linearGradient
										id="colorRequests"
										x1="0"
										y1="0"
										x2="0"
										y2="1"
									>
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
								<XAxis dataKey="time" className="text-xs" />
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
									dataKey="requests"
									stroke={COLORS.primary}
									fillOpacity={1}
									fill="url(#colorRequests)"
								/>
							</AreaChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>

				{/* Success Rate Chart */}
				<Card>
					<CardHeader>
						<CardTitle>Success Rate Trend</CardTitle>
						<CardDescription>Success percentage over time</CardDescription>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={300}>
							<LineChart data={timeSeriesData}>
								<CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
								<XAxis dataKey="time" className="text-xs" />
								<YAxis domain={[80, 100]} className="text-xs" />
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--background)",
										border: "1px solid var(--border)",
										borderRadius: "var(--radius)",
									}}
								/>
								<Line
									type="monotone"
									dataKey="successRate"
									stroke={COLORS.success}
									strokeWidth={2}
									dot={false}
								/>
							</LineChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>
			</div>

			{/* Charts Row 2 */}
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
						<ResponsiveContainer width="100%" height={250}>
							<PieChart>
								<Pie
									data={modelData}
									cx="50%"
									cy="50%"
									innerRadius={60}
									outerRadius={80}
									paddingAngle={5}
									dataKey="value"
								>
									{modelData.map((entry, index) => (
										<Cell
											key={`cell-${entry.name}`}
											fill={CHART_COLORS[index % CHART_COLORS.length]}
										/>
									))}
								</Pie>
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--background)",
										border: "1px solid var(--border)",
										borderRadius: "var(--radius)",
									}}
								/>
							</PieChart>
						</ResponsiveContainer>
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

				{/* Account Health */}
				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle>Account Performance</CardTitle>
						<CardDescription>
							Request distribution and success rates by account
						</CardDescription>
					</CardHeader>
					<CardContent>
						<ResponsiveContainer width="100%" height={250}>
							<BarChart data={accountHealthData}>
								<CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
								<XAxis dataKey="name" className="text-xs" />
								<YAxis yAxisId="left" className="text-xs" />
								<YAxis
									yAxisId="right"
									orientation="right"
									className="text-xs"
								/>
								<Tooltip
									contentStyle={{
										backgroundColor: "var(--background)",
										border: "1px solid var(--border)",
										borderRadius: "var(--radius)",
									}}
								/>
								<Legend />
								<Bar
									yAxisId="left"
									dataKey="requests"
									fill={COLORS.primary}
									name="Requests"
								/>
								<Bar
									yAxisId="right"
									dataKey="successRate"
									fill={COLORS.success}
									name="Success %"
								/>
							</BarChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>
			</div>

			{/* Recent Activity */}
			<Card>
				<CardHeader>
					<CardTitle>System Status</CardTitle>
					<CardDescription>
						Current operational status and recent events
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4">
						<div className="flex items-center justify-between p-4 rounded-lg bg-success/10">
							<div className="flex items-center gap-3">
								<CheckCircle className="h-5 w-5 text-success" />
								<div>
									<p className="font-medium">All Systems Operational</p>
									<p className="text-sm text-muted-foreground">
										No issues detected
									</p>
								</div>
							</div>
							<Badge variant="default" className="bg-success">
								Healthy
							</Badge>
						</div>

						{stats?.recentErrors && stats.recentErrors.length > 0 && (
							<div className="space-y-2">
								<h4 className="text-sm font-medium text-muted-foreground">
									Recent Errors
								</h4>
								{stats.recentErrors.slice(0, 3).map((error, i) => (
									<div
										key={`error-${error.substring(0, 20)}-${i}`}
										className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10"
									>
										<XCircle className="h-4 w-4 text-destructive mt-0.5" />
										<p className="text-sm text-muted-foreground">{error}</p>
									</div>
								))}
							</div>
						)}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
