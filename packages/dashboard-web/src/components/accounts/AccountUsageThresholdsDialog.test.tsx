import { describe, expect, it } from "bun:test";
import type { Account } from "../../api";
import { getThresholdLabels } from "./AccountUsageThresholdsDialog";

const baseAccount: Account = {
	id: "account-1",
	name: "test-account",
	provider: "anthropic",
	requestCount: 0,
	totalRequests: 0,
	lastUsed: null,
	created: new Date(0).toISOString(),
	paused: false,
	requiresReauth: false,
	pauseReason: null,
	tokenStatus: "valid",
	tokenExpiresAt: null,
	rateLimitStatus: "OK",
	rateLimitReset: null,
	rateLimitRemaining: null,
	rateLimitedUntil: null,
	rateLimitedReason: null,
	rateLimitedAt: null,
	sessionInfo: "No active session",
	priority: 1,
	autoFallbackEnabled: true,
	autoRefreshEnabled: true,
	usagePauseFiveHourThreshold: null,
	usagePauseWeeklyThreshold: null,
	usagePauseFiveHourEnabled: false,
	usagePauseWeeklyEnabled: false,
	customEndpoint: null,
	modelMappings: null,
	requestTransformer: null,
	usageUtilization: null,
	usageWindow: null,
	usageData: null,
	usageRateLimitedUntil: null,
	usageThrottledUntil: null,
	usageThrottledWindows: [],
	hasRefreshToken: false,
	sessionStats: null,
	isPrimary: false,
	lastManualReauthAt: null,
	reauthDeadlineStatus: null,
	daysUntilReauthRequired: null,
	hoursUntilReauthRequired: null,
};

describe("getThresholdLabels", () => {
	it("labels the windows Daily and Monthly for nanogpt accounts", () => {
		const labels = getThresholdLabels({ ...baseAccount, provider: "nanogpt" });

		expect(labels).toEqual({ fiveHourLabel: "Daily", weeklyLabel: "Monthly" });
	});

	it("keeps the 5-hour and Weekly labels for other providers", () => {
		expect(
			getThresholdLabels({ ...baseAccount, provider: "anthropic" }),
		).toEqual({ fiveHourLabel: "5-hour", weeklyLabel: "Weekly" });

		expect(getThresholdLabels({ ...baseAccount, provider: "zai" })).toEqual({
			fiveHourLabel: "5-hour",
			weeklyLabel: "Weekly",
		});
	});

	it("keeps the 5-hour and Weekly labels when there is no account", () => {
		expect(getThresholdLabels(null)).toEqual({
			fiveHourLabel: "5-hour",
			weeklyLabel: "Weekly",
		});
	});
});
