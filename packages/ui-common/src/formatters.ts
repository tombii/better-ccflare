import { TIME_CONSTANTS } from "@claudeflare/core";

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	if (bytes === 0) return "0 B";

	const index = Math.floor(Math.log(bytes) / Math.log(1024));
	const value = bytes / 1024 ** index;

	return `${value.toFixed(2)} ${units[index]}`;
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
	if (ms < TIME_CONSTANTS.SECOND) return `${ms}ms`;
	if (ms < TIME_CONSTANTS.MINUTE)
		return `${(ms / TIME_CONSTANTS.SECOND).toFixed(1)}s`;
	if (ms < TIME_CONSTANTS.HOUR)
		return `${(ms / TIME_CONSTANTS.MINUTE).toFixed(1)}m`;
	return `${(ms / TIME_CONSTANTS.HOUR).toFixed(1)}h`;
}

/**
 * Format tokens with locale-aware thousands separator
 */
export function formatTokens(tokens?: number): string {
	if (!tokens || tokens === 0) return "0";
	return tokens.toLocaleString();
}

/**
 * Format USD cost with 4 decimal places
 */
export function formatCost(cost?: number): string {
	if (!cost || cost === 0) return "$0.0000";
	return `$${cost.toFixed(4)}`;
}

/**
 * Format percentage with specified decimal places
 */
export function formatPercentage(value: number, decimals = 1): string {
	return `${value.toFixed(decimals)}%`;
}

/**
 * Format number with locale-aware thousands separator
 */
export function formatNumber(value: number): string {
	return value.toLocaleString();
}

/**
 * Format timestamp to locale string
 */
export function formatTimestamp(timestamp: number | string): string {
	const date =
		typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
	return date.toLocaleString();
}

/**
 * Format relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: number | Date): string {
	const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();

	const seconds = Math.floor(diffMs / TIME_CONSTANTS.SECOND);
	const minutes = Math.floor(diffMs / TIME_CONSTANTS.MINUTE);
	const hours = Math.floor(diffMs / TIME_CONSTANTS.HOUR);
	const days = Math.floor(diffMs / TIME_CONSTANTS.DAY);

	if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
	if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
	if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
	if (seconds > 0) return `${seconds} second${seconds > 1 ? "s" : ""} ago`;
	return "just now";
}
