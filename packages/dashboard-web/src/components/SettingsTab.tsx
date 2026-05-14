import React from "react";
import { CacheKeepaliveCard } from "./overview/CacheKeepaliveCard";
import { DashboardAuthCard } from "./overview/DashboardAuthCard";
import { DataRetentionCard } from "./overview/DataRetentionCard";
import { SystemCacheTtlCard } from "./overview/SystemCacheTtlCard";
import { UsageThrottlingCard } from "./overview/UsageThrottlingCard";

export const SettingsTab = React.memo(() => {
	return (
		<div className="space-y-6">
			{/* Configuration Cards Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<DashboardAuthCard />
				<CacheKeepaliveCard />
				<SystemCacheTtlCard />
				<UsageThrottlingCard />
				<DataRetentionCard />
			</div>
		</div>
	);
});
