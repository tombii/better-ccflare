import { registerUIRefresh } from "@better-ccflare/core";
import type { FullUsageData } from "@better-ccflare/types";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { providerShowsWeeklyUsage } from "../../utils/provider-utils";
import { Progress } from "../ui/progress";

interface RateLimitProgressProps {
	resetIso: string | null;
	usageUtilization?: number | null; // Actual utilization from API (0-100)
	usageWindow?: string | null; // Window name (e.g., "five_hour")
	usageData?: FullUsageData | null; // Full usage data from API
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
		case "seven_day_opus":
			return "Opus (Weekly)";
		case "seven_day_sonnet":
			return "Sonnet (Weekly)";
		case "daily":
			return "Daily";
		case "monthly":
			return "Monthly";
		case "time_limit":
			return "Time";
		case "tokens_limit":
			return "Tokens";
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
		const unregisterInterval = registerUIRefresh({
			id: "rate-limit-progress-update",
			callback: () => setNow(Date.now()),
			seconds: 30,
			description: "Rate limit progress UI update",
		});
		return unregisterInterval;
	}, []);

	// Allow null resetIso for providers that show usage data (like NanoGPT in PayG mode)
	// but still render null if there's no resetIso and no usage data to show
	if (!resetIso && !usageData) return null;

	const resetTime = resetIso ? new Date(resetIso).getTime() : Date.now();
	const remainingMs = Math.max(0, resetTime - now);
	const remainingMinutes = Math.ceil(remainingMs / 60000);
	const _remainingHours = Math.floor(remainingMinutes / 60);
	const _remainingMins = remainingMinutes % 60;

	// Determine which usage windows to display
	const usages: UsageDisplay[] = [];

	// Check if this is NanoGPT usage data (has 'active' and 'daily' properties)
	const isNanoGPTData =
		usageData &&
		"active" in usageData &&
		"daily" in usageData &&
		"monthly" in usageData;

	// Check if this is Zai usage data (has 'time_limit' and 'tokens_limit' properties)
	const isZaiData =
		usageData && ("time_limit" in usageData || "tokens_limit" in usageData);

	if (isZaiData && showWeekly) {
		// Zai usage data - only show tokens_limit (5-hour token quota)
		const zaiData = usageData as {
			time_limit?: { percentage: number; resetAt: number } | null;
			tokens_limit?: { percentage: number; resetAt: number } | null;
		};

		// Tokens limit usage (5-hour token quota)
		if (zaiData.tokens_limit) {
			usages.push({
				utilization: zaiData.tokens_limit.percentage,
				window: "five_hour", // Map to "5-hour" to match Claude terminology
				resetTime: zaiData.tokens_limit.resetAt
					? new Date(zaiData.tokens_limit.resetAt).toISOString()
					: null,
			});
		}
	} else if (isNanoGPTData && showWeekly) {
		// NanoGPT usage data - show daily and monthly windows
		const nanogptData = usageData as {
			active: boolean;
			daily: { percentUsed: number; resetAt: number };
			monthly: { percentUsed: number; resetAt: number };
		};

		// Only show usage if subscription is active
		if (nanogptData.active) {
			// Daily usage
			if (nanogptData.daily) {
				usages.push({
					utilization: nanogptData.daily.percentUsed * 100, // Convert 0-1 to 0-100
					window: "daily",
					resetTime: new Date(nanogptData.daily.resetAt).toISOString(),
				});
			}

			// Monthly usage
			if (nanogptData.monthly) {
				usages.push({
					utilization: nanogptData.monthly.percentUsed * 100, // Convert 0-1 to 0-100
					window: "monthly",
					resetTime: new Date(nanogptData.monthly.resetAt).toISOString(),
				});
			}
		} else {
			// PayG mode - show that no subscription is active
			usages.push({
				utilization: null,
				window: "daily",
				resetTime: null,
			});
		}
	} else if (providerShowsWeeklyUsage(provider) && showWeekly) {
		// Anthropic usage data - show 5-hour and weekly usage
		const anthropicData = usageData as {
			five_hour?: { utilization: number | null; resets_at: string | null };
			seven_day?: { utilization: number | null; resets_at: string | null };
			seven_day_opus?: { utilization: number | null; resets_at: string | null };
			seven_day_sonnet?: {
				utilization: number | null;
				resets_at: string | null;
			};
		};
		if (anthropicData?.five_hour) {
			usages.push({
				utilization: anthropicData.five_hour.utilization,
				window: "five_hour",
				resetTime: anthropicData.five_hour.resets_at,
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
			anthropicData &&
			anthropicData.seven_day &&
			anthropicData.seven_day.utilization !== null &&
			anthropicData.seven_day.utilization !== undefined
		) {
			usages.push({
				utilization: anthropicData.seven_day.utilization,
				window: "seven_day",
				resetTime: anthropicData.seven_day.resets_at,
			});
		} else {
			// Add weekly usage as placeholder if data is not available
			usages.push({
				utilization: null,
				window: "seven_day",
				resetTime: null,
			});
		}

		// Check if seven_day_opus data exists, has valid utilization, and resets_at is not null
		if (
			anthropicData &&
			anthropicData.seven_day_opus &&
			anthropicData.seven_day_opus.utilization !== null &&
			anthropicData.seven_day_opus.utilization !== undefined &&
			anthropicData.seven_day_opus.resets_at !== null
		) {
			usages.push({
				utilization: anthropicData.seven_day_opus.utilization,
				window: "seven_day_opus",
				resetTime: anthropicData.seven_day_opus.resets_at,
			});
		}

		// Check if seven_day_sonnet data exists, has valid utilization, and resets_at is not null
		if (
			anthropicData &&
			anthropicData.seven_day_sonnet &&
			anthropicData.seven_day_sonnet.utilization !== null &&
			anthropicData.seven_day_sonnet.utilization !== undefined &&
			anthropicData.seven_day_sonnet.resets_at !== null
		) {
			usages.push({
				utilization: anthropicData.seven_day_sonnet.utilization,
				window: "seven_day_sonnet",
				resetTime: anthropicData.seven_day_sonnet.resets_at,
			});
		}
	} else if (
		providerShowsWeeklyUsage(provider) &&
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
				} else if (
					usage.window === "seven_day_opus" ||
					usage.window === "seven_day_sonnet"
				) {
					// Special handling for weekly opus/sonnet data when reset time is not available
					windowTimeText = "Data unavailable";
				} else if (usage.window === "daily" || usage.window === "monthly") {
					// Special handling for NanoGPT when no subscription is active (PayG mode)
					windowTimeText = "No subscription (PayG mode)";
				}

				// Special rendering for PayG mode - just show message without progress bar
				if (
					(usage.window === "daily" || usage.window === "monthly") &&
					!usage.resetTime
				) {
					return (
						<div key={usage.window || "default"} className="space-y-2">
							<div className="flex items-center justify-between">
								<span className="text-xs text-muted-foreground">
									No subscription (PayG mode)
								</span>
							</div>
						</div>
					);
				}

				return (
					<div key={usage.window || "default"} className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-xs text-muted-foreground">
								{providerShowsWeeklyUsage(provider) && usage.window
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
									{usage.window === "seven_day" ||
									usage.window === "seven_day_opus" ||
									usage.window === "seven_day_sonnet" ||
									usage.window === "monthly" ||
									usage.window === "time_limit" ||
									usage.window === "tokens_limit"
										? `Resets ${new Date(usage.resetTime).toLocaleString(
												undefined,
												{
													month: "short",
													day: "numeric",
													hour: "2-digit",
													minute: "2-digit",
												},
											)} (local)`
										: `Resets ${new Date(usage.resetTime).toLocaleTimeString(
												undefined,
												{
													hour: "2-digit",
													minute: "2-digit",
												},
											)} (local)`}
								</span>
							</div>
						)}
						{!usage.resetTime &&
							(usage.window === "seven_day" ||
								usage.window === "seven_day_opus" ||
								usage.window === "seven_day_sonnet" ||
								usage.window === "daily" ||
								usage.window === "monthly") && (
								<div className="flex items-center justify-between">
									<span className="text-xs text-muted-foreground">
										{windowTimeText}
									</span>
									<span className="text-xs text-muted-foreground">
										{usage.window === "daily" || usage.window === "monthly"
											? "Using pay-as-you-go"
											: "No reset data available"}
									</span>
								</div>
							)}
					</div>
				);
			})}
		</div>
	);
}
