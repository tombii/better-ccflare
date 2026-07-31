import { AlertTriangle } from "lucide-react";
import React, { useState } from "react";
import type { TimeRange } from "../constants";
import {
	useAnomalyInsights,
	useCacheInsights,
	useContextInsights,
} from "../hooks/queries";
import { AlertsView } from "./insights/AlertsView";
import { AnomaliesView } from "./insights/AnomaliesView";
import { CacheEfficiencyView } from "./insights/CacheEfficiencyView";
import { ContextCompositionView } from "./insights/ContextCompositionView";
import { TimeRangeSelector } from "./overview/TimeRangeSelector";
import { Card, CardContent } from "./ui/card";

export const InsightsTab = React.memo(() => {
	const [timeRange, setTimeRange] = useState<TimeRange>("24h");

	// Fetch cache insights with automatic refetch on range changes
	const { data, isLoading: loading, isError } = useCacheInsights(timeRange);
	const {
		data: contextData,
		isLoading: contextLoading,
		isError: contextError,
	} = useContextInsights(timeRange);
	const {
		data: anomalyData,
		isLoading: anomalyLoading,
		isError: anomalyError,
	} = useAnomalyInsights(timeRange);

	return (
		<div className="space-y-6">
			{/* Controls */}
			<div className="flex flex-col sm:flex-row gap-4 justify-between">
				<TimeRangeSelector
					value={timeRange}
					onChange={(value) => setTimeRange(value as TimeRange)}
				/>
			</div>

			{isError ? (
				<Card>
					<CardContent className="p-6">
						<div className="flex items-center gap-2 text-destructive">
							<AlertTriangle className="h-5 w-5" />
							<span>Failed to load cache insights. Please try again.</span>
						</div>
					</CardContent>
				</Card>
			) : (
				<CacheEfficiencyView
					data={data}
					loading={loading}
					timeRange={timeRange}
				/>
			)}

			{contextError ? (
				<Card>
					<CardContent className="p-6">
						<div className="flex items-center gap-2 text-destructive">
							<AlertTriangle className="h-5 w-5" />
							<span>Failed to load context insights. Please try again.</span>
						</div>
					</CardContent>
				</Card>
			) : (
				<ContextCompositionView
					data={contextData}
					loading={contextLoading}
					timeRange={timeRange}
				/>
			)}

			{anomalyError ? (
				<Card>
					<CardContent className="p-6">
						<div className="flex items-center gap-2 text-destructive">
							<AlertTriangle className="h-5 w-5" />
							<span>Failed to load anomaly insights. Please try again.</span>
						</div>
					</CardContent>
				</Card>
			) : (
				<AnomaliesView
					data={anomalyData}
					loading={anomalyLoading}
					timeRange={timeRange}
				/>
			)}

			<AlertsView />
		</div>
	);
});

InsightsTab.displayName = "InsightsTab";
