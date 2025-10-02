import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Progress } from "../ui/progress";

interface RateLimitProgressProps {
	resetIso: string | null;
	usageUtilization?: number | null; // Actual utilization from API (0-100)
	usageWindow?: string | null; // Window name (e.g., "five_hour")
	usageData?: any | null; // Full usage data from API
	provider: string;
	className?: string;
	showWeekly?: boolean; // Whether to show weekly usage as well
}

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in milliseconds

// Format window name for display
function formatWindowName(window: string | null): string {
	if (!window) return "window";
	switch (window) {
		case "five_hour":
			return "5-hour";
		case "seven_day":
			return "Weekly";
		default:
			return window.replace("_", " ");
	}
}

interface UsageDisplay {
	utilization: number | null;
	window: string | null;
	resetTime: string | null;
}

export function RateLimitProgress({
	resetIso,
	usageUtilization,
	usageWindow,
	usageData,
	provider,
	className,
	showWeekly = false,
}: RateLimitProgressProps) {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), 30000); // Update every 30 seconds
		return () => clearInterval(interval);
	}, []);

	if (!resetIso) return null;

	const resetTime = new Date(resetIso).getTime();
	const remainingMs = Math.max(0, resetTime - now);
	const remainingMinutes = Math.ceil(remainingMs / 60000);
	const _remainingHours = Math.floor(remainingMinutes / 60);
	const _remainingMins = remainingMinutes % 60;

	// Determine which usage windows to display
	const usages: UsageDisplay[] = [];

	if (provider === "anthropic" && showWeekly) {
		// Always show both 5-hour and weekly usage for Anthropic accounts
		if (usageData?.five_hour) {
			usages.push({
				utilization: usageData.five_hour.utilization,
				window: "five_hour",
				resetTime: usageData.five_hour.resets_at,
			});
		} else {
			// Fallback: use the most restrictive window data for 5-hour display
			usages.push({
				utilization: usageUtilization ?? null,
				window: "five_hour",
				resetTime: resetIso,
			});
		}

		// Check if seven_day data exists and has valid utilization
		if (
			usageData &&
			usageData.seven_day &&
			usageData.seven_day.utilization !== null &&
			usageData.seven_day.utilization !== undefined
		) {
			usages.push({
				utilization: usageData.seven_day.utilization,
				window: "seven_day",
				resetTime: usageData.seven_day.resets_at,
			});
		} else {
			// Add weekly usage as placeholder if data is not available
			usages.push({
				utilization: null,
				window: "seven_day",
				resetTime: null,
			});
		}
	} else if (
		provider === "anthropic" &&
		usageUtilization !== null &&
		usageUtilization !== undefined &&
		usageWindow
	) {
		// Fallback: show only the most restrictive window
		usages.push({
			utilization: usageUtilization,
			window: usageWindow,
			resetTime: resetIso,
		});
	} else {
		// Use time-based percentage for non-Anthropic or when no usage data is available
		const percentage = Math.min(
			100,
			Math.max(0, ((now - (resetTime - WINDOW_MS)) / WINDOW_MS) * 100),
		);
		usages.push({
			utilization: percentage as number | null,
			window: null,
			resetTime: resetIso,
		});
	}

	return (
		<div className={cn("space-y-3", className)}>
			{usages.map((usage, _index) => {
				const percentage = usage.utilization;
				const isAvailable = percentage !== null;

				// Calculate time remaining for this specific window
				let windowTimeText = "";
				if (usage.resetTime) {
					const windowResetTime = new Date(usage.resetTime).getTime();
					const windowRemainingMs = Math.max(0, windowResetTime - now);
					const windowRemainingMinutes = Math.ceil(windowRemainingMs / 60000);
					const windowRemainingHours = Math.floor(windowRemainingMinutes / 60);
					const windowRemainingMins = windowRemainingMinutes % 60;

					if (windowRemainingMs <= 0) {
						windowTimeText = "Ready to refresh";
					} else if (windowRemainingHours > 0) {
						windowTimeText = `${windowRemainingHours}h ${windowRemainingMins}m`;
					} else {
						windowTimeText = `${windowRemainingMinutes}m`;
					}
				} else if (usage.window === "seven_day") {
					// Special handling for weekly data when reset time is not available
					windowTimeText = "Data unavailable";
				}

				return (
					<div key={usage.window || "default"} className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">
								{provider === "anthropic" && usage.window
									? `Usage (${formatWindowName(usage.window)})`
									: "Rate limit window"}
							</span>
							<span className="text-xs font-medium text-muted-foreground">
								{isAvailable ? `${percentage?.toFixed(0)}%` : "N/A"}
							</span>
						</div>
						<Progress value={isAvailable ? percentage : 0} className="h-2" />
						{usage.resetTime && (
							<div className="flex items-center justify-between">
								<span className="text-xs text-muted-foreground">
									{windowTimeText === "Ready to refresh"
										? windowTimeText
										: `${windowTimeText} until refresh`}
								</span>
								<span className="text-xs text-muted-foreground">
									{usage.window === "seven_day"
										? `Resets at ${new Date(usage.resetTime).toLocaleString()}`
										: `Resets at ${new Date(usage.resetTime).toLocaleTimeString()}`}
								</span>
							</div>
						)}
						{!usage.resetTime && usage.window === "seven_day" && (
							<div className="flex items-center justify-between">
								<span className="text-xs text-muted-foreground">
									{windowTimeText}
								</span>
								<span className="text-xs text-muted-foreground">
									No reset data available
								</span>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
