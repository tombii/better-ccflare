import React from "react";
import { CacheKeepaliveCard } from "./overview/CacheKeepaliveCard";
import { DataRetentionCard } from "./overview/DataRetentionCard";
import { SystemCacheTtlCard } from "./overview/SystemCacheTtlCard";

export const SettingsTab = React.memo(() => {
	return (
		<div className="space-y-6">
			{/* Configuration Cards Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<CacheKeepaliveCard />
				<SystemCacheTtlCard />
				<DataRetentionCard />
			</div>
		</div>
	);
});
