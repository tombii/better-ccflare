import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Progress } from "../ui/progress";

interface RateLimitProgressProps {
	resetIso: string | null;
	usageUtilization?: number | null; // Actual utilization from API (0-100)
	usageWindow?: string | null; // Window name (e.g., "five_hour")
	provider: string;
	className?: string;
}

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds

// Format window name for display
function formatWindowName(window: string | null): string {
	if (!window) return "window";
	return window.replace("_", " ");
}

export function RateLimitProgress({
	resetIso,
	usageUtilization,
	usageWindow,
	provider,
	className,
}: RateLimitProgressProps) {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), 10000); // Update every 10 seconds
		return () => clearInterval(interval);
	}, []);

	if (!resetIso) return null;

	const resetTime = new Date(resetIso).getTime();
	const remainingMs = Math.max(0, resetTime - now);
	const remainingMinutes = Math.ceil(remainingMs / 60000);
	const remainingHours = Math.floor(remainingMinutes / 60);
	const remainingMins = remainingMinutes % 60;

	// Use actual usage percentage for Anthropic, fallback to time-based for others
	const percentage =
		provider === "anthropic" && usageUtilization !== null
			? usageUtilization
			: Math.min(
					100,
					Math.max(0, ((now - (resetTime - WINDOW_MS)) / WINDOW_MS) * 100),
				);

	// Format time remaining
	let timeText = "";
	if (remainingMs <= 0) {
		timeText = "Ready to refresh";
	} else if (remainingHours > 0) {
		timeText = `${remainingHours}h ${remainingMins}m until refresh`;
	} else {
		timeText = `${remainingMinutes}m until refresh`;
	}

	const label =
		provider === "anthropic"
			? `Usage (${formatWindowName(usageWindow ?? null)})`
			: "Rate limit window";

	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">{label}</span>
				<span className="text-xs font-medium text-muted-foreground">
					{percentage?.toFixed(0) ?? "0"}%
				</span>
			</div>
			<Progress value={percentage} className="h-2" />
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">{timeText}</span>
				{remainingMs > 0 && (
					<span className="text-xs text-muted-foreground">
						Resets at {new Date(resetTime).toLocaleTimeString()}
					</span>
				)}
			</div>
		</div>
	);
}
