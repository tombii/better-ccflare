import { Suspense } from "react";
import { AnalyticsLoadingSkeleton } from "./AnalyticsLoadingSkeleton";
import { AnalyticsTab } from "./AnalyticsTab";

// Lazy loaded Analytics component for code splitting
export const LazyAnalytics = () => (
	<Suspense fallback={<AnalyticsLoadingSkeleton />}>
		<AnalyticsTab />
	</Suspense>
);
