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
	requestTransformer: null,
	usageUtilization: null,
	usageWindow: null,
	usageData: null,
	usageRateLimitedUntil: null,
	usageThrottledUntil: null,
	usageThrottledWindows: [],
	hasRefreshToken: true,
	sessionStats: null,
	isPrimary: false,
	lastManualReauthAt: null,
	reauthDeadlineStatus: null,
	daysUntilReauthRequired: null,
	hoursUntilReauthRequired: null,
};

function renderAccount(
	account: Account,
	onRequestTransformerChange?: (account: Account) => void,
): string {
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
			onRequestTransformerChange={onRequestTransformerChange}
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

	it("shows no reauth-deadline badge when the status is ok or null", () => {
		expect(renderAccount(baseAccount)).not.toContain("Reauth in");
		expect(
			renderAccount({
				...baseAccount,
				reauthDeadlineStatus: "ok",
				daysUntilReauthRequired: 10,
				hoursUntilReauthRequired: 240,
			}),
		).not.toContain("Reauth in");
	});

	it("shows the reauth-deadline badge in days when 24h or more remain", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "warning",
			daysUntilReauthRequired: 3,
			hoursUntilReauthRequired: 60,
		});

		expect(html).toContain("Reauth in 3d");
	});

	it("shows the reauth-deadline badge in hours once under 24h, even at warning tier", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "warning",
			daysUntilReauthRequired: 1,
			hoursUntilReauthRequired: 22,
		});

		expect(html).toContain("Reauth in 22h");
		expect(html).not.toContain("Reauth in 1d");
	});

	it("shows the reauth-deadline badge in hours at critical tier", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "critical",
			daysUntilReauthRequired: 1,
			hoursUntilReauthRequired: 6,
		});

		expect(html).toContain("Reauth in 6h");
	});

	it("hides the reauth-deadline badge when the account already requires authentication", () => {
		const html = renderAccount({
			...baseAccount,
			requiresReauth: true,
			reauthDeadlineStatus: "critical",
			daysUntilReauthRequired: 1,
			hoursUntilReauthRequired: 6,
		});

		expect(html).not.toContain("Reauth in");
	});

	it("shows an overdue badge when the deadline has already passed", () => {
		const html = renderAccount({
			...baseAccount,
			reauthDeadlineStatus: "expired",
			daysUntilReauthRequired: -2,
			hoursUntilReauthRequired: -48,
		});

		expect(html).toContain("Reauth overdue by 2d");
	});

	it("hides the reauth-deadline badge when the account already requires authentication, even when expired", () => {
		const html = renderAccount({
			...baseAccount,
			requiresReauth: true,
			reauthDeadlineStatus: "expired",
			daysUntilReauthRequired: -2,
			hoursUntilReauthRequired: -48,
		});

		expect(html).not.toContain("Reauth overdue");
	});

	it("shows the request transformer action only for openai-compatible accounts", () => {
		const onRequestTransformerChange = () => {};
		const openAICompatibleHtml = renderAccount(
			{
				...baseAccount,
				provider: "openai-compatible",
			},
			onRequestTransformerChange,
		);
		const anthropicCompatibleHtml = renderAccount(
			{
				...baseAccount,
				provider: "anthropic-compatible",
			},
			onRequestTransformerChange,
		);

		expect(openAICompatibleHtml).toContain(
			'aria-label="Configure request transformer"',
		);
		expect(anthropicCompatibleHtml).not.toContain(
			'aria-label="Configure request transformer"',
		);
	});

	it("highlights the request transformer action when a transformer is enabled", () => {
		const disabledHtml = renderAccount(
			{
				...baseAccount,
				provider: "openai-compatible",
			},
			() => {},
		);
		const enabledHtml = renderAccount(
			{
				...baseAccount,
				provider: "openai-compatible",
				requestTransformer: "max-tokens-to-max-completion-tokens",
			},
			() => {},
		);

		expect(disabledHtml).toContain('aria-pressed="false"');
		expect(disabledHtml).not.toContain(
			"lucide lucide-replace h-4 w-4 text-primary",
		);
		expect(enabledHtml).toContain('aria-pressed="true"');
		expect(enabledHtml).toContain("lucide lucide-replace h-4 w-4 text-primary");
	});
});
