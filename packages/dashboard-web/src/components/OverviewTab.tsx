import {
	formatCost,
	formatNumber,
	formatPercentage,
} from "@ccflare/ui-common";
import { format } from "date-fns";
import { Activity, CheckCircle, Clock, DollarSign } from "lucide-react";
import { useMemo } from "react";
import { REFRESH_INTERVALS } from "../constants";
import { useAccounts, useAnalytics, useStats } from "../hooks/queries";
import { ChartsSection } from "./overview/ChartsSection";
import { LoadingSkeleton } from "./overview/LoadingSkeleton";
import { MetricCard } from "./overview/MetricCard";
import { RateLimitInfo } from "./overview/RateLimitInfo";
import { SystemStatus } from "./overview/SystemStatus";
import { StrategyCard } from "./StrategyCard";

export function OverviewTab() {
	// Fetch all data using React Query hooks
	const { data: stats, isLoading: statsLoading } = useStats(
		REFRESH_INTERVALS.default,
	);
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		"24h",
		{ accounts: [], models: [], status: "all" },
		"normal",
	);
	const { data: accounts, isLoading: accountsLoading } = useAccounts();

	const loading = statsLoading || analyticsLoading || accountsLoading;
	const combinedData =
		stats && analytics && accounts ? { stats, analytics, accounts } : null;

	// Transform time series data
	const timeSeriesData = useMemo(() => {
		if (!analytics) return [];
		return analytics.timeSeries.map((point) => ({
			time: format(new Date(point.ts), "HH:mm"),
			requests: point.requests,
			successRate: point.successRate,
			responseTime: Math.round(point.avgResponseTime),
			cost: point.costUsd.toFixed(2),
		}));
	}, [analytics]);

	if (loading && !combinedData) {
		return <LoadingSkeleton />;
	}

	// Helper function to calculate percentage change
	function pctChange(current: number, previous: number): number | null {
		if (previous === 0) return null; // avoid division by zero
		return ((current - previous) / previous) * 100;
	}

	// Calculate percentage changes from time series data
	let deltaRequests: number | null = null;
	let deltaSuccessRate: number | null = null;
	let deltaResponseTime: number | null = null;
	let deltaCost: number | null = null;
	let trendRequests: "up" | "down" | "flat" = "flat";
	let trendSuccessRate: "up" | "down" | "flat" = "flat";
	let trendResponseTime: "up" | "down" | "flat" = "flat";
	let trendCost: "up" | "down" | "flat" = "flat";

	if (timeSeriesData.length >= 2) {
		const lastBucket = timeSeriesData[timeSeriesData.length - 1];
		const prevBucket = timeSeriesData[timeSeriesData.length - 2];

		// Calculate deltas
		deltaRequests = pctChange(lastBucket.requests, prevBucket.requests);
		deltaSuccessRate = pctChange(
			lastBucket.successRate,
			prevBucket.successRate,
		);
		// For response time, lower is better, so we invert the calculation
		deltaResponseTime = pctChange(
			prevBucket.responseTime,
			lastBucket.responseTime,
		);
		deltaCost = pctChange(
			Number.parseFloat(lastBucket.cost),
			Number.parseFloat(prevBucket.cost),
		);

		// Determine trends
		trendRequests =
			deltaRequests !== null ? (deltaRequests >= 0 ? "up" : "down") : "flat";
		trendSuccessRate =
			deltaSuccessRate !== null
				? deltaSuccessRate >= 0
					? "up"
					: "down"
				: "flat";
		// For response time, lower is better (negative change is good)
		trendResponseTime =
			deltaResponseTime !== null
				? deltaResponseTime >= 0
					? "up"
					: "down"
				: "flat";
		// For cost, higher is bad (positive change is bad)
		trendCost = deltaCost !== null ? (deltaCost >= 0 ? "down" : "up") : "flat";
	}

	// Use analytics data for model distribution
	const modelData =
		analytics?.modelDistribution?.map((model) => ({
			name: model.model || "Unknown",
			value: model.count,
		})) || [];

	// Use analytics data for account health
	const accountHealthData = analytics?.accountPerformance || [];

	return (
		<div className="space-y-6">
			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				<MetricCard
					title="Total Requests"
					value={formatNumber(analytics?.totals.requests || 0)}
					change={deltaRequests !== null ? deltaRequests : undefined}
					trend={trendRequests}
					icon={Activity}
				/>
				<MetricCard
					title="Success Rate"
					value={formatPercentage(analytics?.totals.successRate || 0, 0)}
					change={deltaSuccessRate !== null ? deltaSuccessRate : undefined}
					trend={trendSuccessRate}
					icon={CheckCircle}
				/>
				<MetricCard
					title="Avg Response Time"
					value={`${Math.round(analytics?.totals.avgResponseTime || 0)}ms`}
					change={deltaResponseTime !== null ? deltaResponseTime : undefined}
					trend={trendResponseTime}
					icon={Clock}
				/>
				<MetricCard
					title="Total Cost"
					value={
						analytics?.totals.totalCostUsd
							? formatCost(analytics.totals.totalCostUsd)
							: "$0.0000"
					}
					change={deltaCost !== null ? deltaCost : undefined}
					trend={trendCost}
					icon={DollarSign}
				/>
			</div>

			<ChartsSection
				timeSeriesData={timeSeriesData}
				modelData={modelData}
				accountHealthData={accountHealthData}
				loading={loading}
			/>

			<SystemStatus recentErrors={stats?.recentErrors} />

			{accounts && <RateLimitInfo accounts={accounts} />}

			{/* Configuration Row */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<StrategyCard />
			</div>
		</div>
	);
}
