import { registerUIRefresh } from "@better-ccflare/core";
import {
	formatCost,
	formatNumber,
	formatPercentage,
	formatTokensPerSecond,
} from "@better-ccflare/ui-common";
import { format } from "date-fns";
import {
	Activity,
	BarChart3,
	Boxes,
	CheckCircle,
	Clock,
	DollarSign,
	Gauge,
	Zap,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { REFRESH_INTERVALS } from "../constants";
import {
	useAccounts,
	useAnalytics,
	useRoutingObservations,
	useStats,
} from "../hooks/queries";
import {
	computePoolUsage,
	computeScopedPoolUsage,
	formatFamilyLabel,
} from "../lib/pool-usage";
import { ChartsSection } from "./overview/ChartsSection";
import { LoadingSkeleton } from "./overview/LoadingSkeleton";
import { MetricCard } from "./overview/MetricCard";
import {
	PoolCapacitySection,
	type PoolCapacitySectionPool,
} from "./overview/PoolCapacitySection";
import { RateLimitInfo } from "./overview/RateLimitInfo";
import {
	StorageIntegrityBanner,
	StorageIntegrityCard,
} from "./overview/StorageIntegrityCard";
import { SystemStatus } from "./overview/SystemStatus";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";

export const OverviewTab = React.memo(() => {
	// Fetch all data using React Query hooks
	const { data: stats, isLoading: statsLoading } = useStats(
		REFRESH_INTERVALS.default,
	);
	const [timeRange, setTimeRange] = useState("24h");
	const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
		timeRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
	);
	const { data: accounts, isLoading: accountsLoading } = useAccounts();
	const { data: routingObservationsResponse } = useRoutingObservations();

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		return registerUIRefresh({
			id: "pool-metric-card-update",
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Combined-quota tile refresh",
		});
	}, []);

	const fiveHourPool = useMemo(
		() => computePoolUsage(accounts ?? [], "five_hour", now),
		[accounts, now],
	);
	const weeklyPool = useMemo(
		() => computePoolUsage(accounts ?? [], "seven_day", now),
		[accounts, now],
	);
	const scopedPools = useMemo(
		() => computeScopedPoolUsage(accounts ?? [], now),
		[accounts, now],
	);

	// The account the active load-balancing strategy would pick for the NEXT
	// request (AccountResponse.isPrimary, filled server-side from
	// strategy.peek() -- see packages/types/src/account.ts). This is the
	// SINGLE source for "next request" display: PoolUsageRow must never
	// recompute routing order itself, since that logic lives in the backend
	// strategy and would drift from it. May be null if no account is primary
	// right now.
	const primaryAccountName = useMemo(
		() => accounts?.find((a) => a.isPrimary)?.name ?? null,
		[accounts],
	);

	const capacityPools: PoolCapacitySectionPool[] = useMemo(
		() => [
			{
				id: "five_hour",
				title: "5h Pool",
				icon: Gauge,
				result: fiveHourPool,
				window: "five_hour" as const,
			},
			{
				id: "seven_day",
				title: "7d Pool",
				icon: BarChart3,
				result: weeklyPool,
				window: "seven_day" as const,
			},
			...scopedPools.map(({ family, result }) => ({
				id: `scoped:${family}`,
				// `family` is the normalized routing key (e.g. "fable") --
				// formatFamilyLabel re-capitalizes it for display ("Fable pool"),
				// matching how ObservedRoutingTable titles the same key.
				title: `${formatFamilyLabel(family)} pool`,
				icon: Boxes,
				result,
				window: "weekly_scoped" as const,
			})),
		],
		[fiveHourPool, weeklyPool, scopedPools],
	);

	// Memoize percentage change calculation (must be at top level)
	const pctChange = useCallback(
		(current: number, previous: number): number | null => {
			if (previous === 0) return null; // avoid division by zero
			return ((current - previous) / previous) * 100;
		},
		[],
	);

	// Memoize trend period description
	const getTrendPeriod = useCallback((range: string): string => {
		switch (range) {
			case "1h":
				return "previous minute";
			case "6h":
				return "previous 5 minutes";
			case "24h":
				return "previous hour";
			case "7d":
				return "previous hour";
			case "30d":
				return "previous day";
			default:
				return "previous period";
		}
	}, []);

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
			planCost: point.planCostUsd ?? 0,
			apiCost: point.apiCostUsd ?? 0,
			tokensPerSecond: point.avgTokensPerSecond || 0,
		}));
	}, [analytics]);

	// Memoize percentage changes calculation
	const trends = useMemo(() => {
		if (timeSeriesData.length < 2) {
			return {
				deltaRequests: null,
				deltaSuccessRate: null,
				deltaResponseTime: null,
				deltaCost: null,
				deltaOutputSpeed: null,
				trendRequests: "flat" as "up" | "down" | "flat",
				trendSuccessRate: "flat" as "up" | "down" | "flat",
				trendResponseTime: "flat" as "up" | "down" | "flat",
				trendCost: "flat" as "up" | "down" | "flat",
				trendOutputSpeed: "flat" as "up" | "down" | "flat",
			};
		}

		const lastBucket = timeSeriesData[timeSeriesData.length - 1];
		const prevBucket = timeSeriesData[timeSeriesData.length - 2];

		// Calculate deltas
		const deltaRequests = pctChange(lastBucket.requests, prevBucket.requests);
		const deltaSuccessRate = pctChange(
			lastBucket.successRate,
			prevBucket.successRate,
		);
		const deltaResponseTime = pctChange(
			lastBucket.responseTime,
			prevBucket.responseTime,
		);
		const deltaCost = pctChange(
			parseFloat(lastBucket.cost),
			parseFloat(prevBucket.cost),
		);
		const deltaOutputSpeed = pctChange(
			lastBucket.tokensPerSecond,
			prevBucket.tokensPerSecond,
		);

		// Helper to determine trend
		const getTrend = (
			delta: number | null,
			invert = false,
		): "up" | "down" | "flat" => {
			if (delta === null) return "flat";
			const isPositive = delta >= 0;
			return invert ? (isPositive ? "down" : "up") : isPositive ? "up" : "down";
		};

		return {
			deltaRequests,
			deltaSuccessRate,
			deltaResponseTime,
			deltaCost,
			deltaOutputSpeed,
			trendRequests: getTrend(deltaRequests),
			trendSuccessRate: getTrend(deltaSuccessRate),
			trendResponseTime: getTrend(deltaResponseTime, true), // invert: higher response time is bad
			trendCost: getTrend(deltaCost, true), // invert: higher cost is bad
			trendOutputSpeed: getTrend(deltaOutputSpeed),
		};
	}, [timeSeriesData, pctChange]);

	if (loading && !combinedData) {
		return <LoadingSkeleton />;
	}

	const trendPeriod = getTrendPeriod(timeRange);

	// Use analytics data for model distribution
	const modelData =
		analytics?.modelDistribution?.map((model) => ({
			name: model.model || "Unknown",
			value: model.count,
		})) || [];

	// Use analytics data for account health
	const accountHealthData = analytics?.accountPerformance || [];

	const accountModelUsageData = analytics?.accountModelUsage || [];
	const apiKeyPerformanceData = analytics?.apiKeyPerformance || [];

	return (
		<div className="space-y-6">
			{/* Sticky corruption banner — only renders when /api/storage reports corrupt */}
			<StorageIntegrityBanner />

			{/* Header with Time Range Selector */}
			<div className="flex justify-between items-center">
				<h2 className="text-2xl font-semibold">Overview</h2>
				<TimeRangeSelector value={timeRange} onChange={setTimeRange} />
			</div>

			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4">
				<MetricCard
					title="Total Requests"
					value={formatNumber(analytics?.totals.requests || 0)}
					change={
						trends.deltaRequests !== null ? trends.deltaRequests : undefined
					}
					trend={trends.trendRequests}
					trendPeriod={trendPeriod}
					icon={Activity}
				/>
				<MetricCard
					title="Success Rate"
					value={formatPercentage(analytics?.totals.successRate || 0, 0)}
					change={
						trends.deltaSuccessRate !== null
							? trends.deltaSuccessRate
							: undefined
					}
					trend={trends.trendSuccessRate}
					trendPeriod={trendPeriod}
					icon={CheckCircle}
				/>
				<MetricCard
					title="Avg Response Time"
					value={`${Math.round(analytics?.totals.avgResponseTime || 0)}ms`}
					change={
						trends.deltaResponseTime !== null
							? trends.deltaResponseTime
							: undefined
					}
					trend={trends.trendResponseTime}
					trendPeriod={trendPeriod}
					icon={Clock}
				/>
				<MetricCard
					title="Plan Value"
					value={
						analytics?.totals.planCostUsd
							? formatCost(analytics.totals.planCostUsd)
							: "$0.0000"
					}
					trendPeriod={trendPeriod}
					icon={DollarSign}
					subRows={[
						{
							label: "Avg / day",
							value: formatCost(analytics?.totals.avgDailyPlanCostUsd ?? 0),
							tooltip: "Average daily plan value over the last 7 days",
						},
						{
							label: "Avg / week",
							value: formatCost(analytics?.totals.avgWeeklyPlanCostUsd ?? 0),
							tooltip:
								"Average weekly plan value, derived from the last 30 days",
						},
					]}
				/>
				<MetricCard
					title="API Cost"
					value={
						analytics?.totals.apiCostUsd
							? formatCost(analytics.totals.apiCostUsd)
							: "$0.0000"
					}
					change={trends.deltaCost !== null ? trends.deltaCost : undefined}
					trend={trends.trendCost}
					trendPeriod={trendPeriod}
					icon={DollarSign}
				/>
				<MetricCard
					title="Output Speed"
					value={formatTokensPerSecond(analytics?.totals.avgTokensPerSecond)}
					change={
						trends.deltaOutputSpeed !== null
							? trends.deltaOutputSpeed
							: undefined
					}
					trend={trends.trendOutputSpeed}
					trendPeriod={trendPeriod}
					icon={Zap}
				/>
			</div>

			<PoolCapacitySection
				pools={capacityPools}
				primaryAccountName={primaryAccountName}
				now={now}
				observations={routingObservationsResponse?.observations}
			/>

			<ChartsSection
				timeSeriesData={timeSeriesData}
				modelData={modelData}
				accountHealthData={accountHealthData}
				accountModelUsageData={accountModelUsageData}
				apiKeyPerformanceData={apiKeyPerformanceData}
				loading={loading}
			/>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<SystemStatus />
				<StorageIntegrityCard />
			</div>

			{accounts && <RateLimitInfo accounts={accounts} />}
		</div>
	);
});
