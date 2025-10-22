import { Skeleton } from "./ui/skeleton";

export function AnalyticsLoadingSkeleton() {
	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex justify-between items-center">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-10 w-40" />
			</div>

			{/* Controls */}
			<div className="flex gap-4">
				<Skeleton className="h-10 w-48" />
				<Skeleton className="h-10 w-32" />
				<Skeleton className="h-10 w-24" />
			</div>

			{/* Metrics Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				{Array.from({ length: 4 }, (_, i) => `metric-${i}`).map((key) => (
					<div key={key} className="p-4 border rounded-lg">
						<Skeleton className="h-6 w-24 mb-2" />
						<Skeleton className="h-8 w-16 mb-1" />
						<Skeleton className="h-4 w-20" />
					</div>
				))}
			</div>

			{/* Charts */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<Skeleton className="h-64 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>

			{/* Additional Charts */}
			<div className="space-y-6">
				<Skeleton className="h-64 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		</div>
	);
}
