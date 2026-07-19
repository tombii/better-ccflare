/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";

const baseAccount: Account = {
	id: "account-1",
	name: "test-account",
	provider: "anthropic",
	requestCount: 0,
	totalRequests: 0,
	lastUsed: null,
	created: new Date(0).toISOString(),
	paused: true,
	requiresReauth: false,
	pauseReason: "overage",
	tokenStatus: "expired",
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
	customEndpoint: null,
	modelMappings: null,
	usageUtilization: null,
	usageWindow: null,
	usageData: null,
	usageRateLimitedUntil: null,
	usageThrottledUntil: null,
	usageThrottledWindows: [],
	hasRefreshToken: true,
	sessionStats: null,
	isPrimary: false,
};

function renderAccount(account: Account): string {
	return renderToStaticMarkup(
		<AccountListItem
			account={account}
			onPauseToggle={() => {}}
			onForceResetRateLimit={() => {}}
			onRefreshUsage={async () => {}}
			onRemove={() => {}}
			onRename={() => {}}
			onPriorityChange={() => {}}
			onAutoFallbackToggle={() => {}}
			onAutoRefreshToggle={() => {}}
			onBillingTypeToggle={() => {}}
			onAnthropicReauth={() => {}}
		/>,
	);
}

describe("AccountListItem", () => {
	it("shows Needs authentication only when requiresReauth is true", () => {
		const healthyHtml = renderAccount(baseAccount);
		const requiresReauthHtml = renderAccount({
			...baseAccount,
			requiresReauth: true,
		});

		expect(healthyHtml).not.toContain("Needs authentication");
		expect(requiresReauthHtml).toContain("Needs authentication");
		expect(requiresReauthHtml).toContain(
			"Refresh token invalid — re-authenticate",
		);
		expect(requiresReauthHtml).not.toContain("Paused (overage)");
	});

	it("shows a human-readable pause reason when re-authentication is not required", () => {
		const html = renderAccount({
			...baseAccount,
			pauseReason: "failure_threshold",
		});

		expect(html).toContain("Paused (failure threshold)");
	});
});
