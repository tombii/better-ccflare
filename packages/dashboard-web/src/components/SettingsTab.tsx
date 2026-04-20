import React from "react";
import { DataRetentionCard } from "./overview/DataRetentionCard";

export const SettingsTab = React.memo(() => {
	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex justify-between items-center">
				<h2 className="text-2xl font-semibold">Settings</h2>
			</div>

			{/* Configuration Cards Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<DataRetentionCard />
			</div>
		</div>
	);
});
