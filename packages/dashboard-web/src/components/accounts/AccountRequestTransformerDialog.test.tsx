/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import {
	AccountRequestTransformerDialogFields,
	REQUEST_TRANSFORMER_NONE_VALUE,
	saveAccountRequestTransformerSelection,
} from "./AccountRequestTransformerDialog";

const account: Account = {
	id: "account-1",
	name: "openai-account",
	provider: "openai-compatible",
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
	customEndpoint: null,
	modelMappings: null,
	requestTransformer: "max-tokens-to-max-completion-tokens",
	usageUtilization: null,
	usageWindow: null,
	usageData: null,
	usageRateLimitedUntil: null,
	usageThrottledUntil: null,
	usageThrottledWindows: [],
	hasRefreshToken: false,
	sessionStats: null,
	isPrimary: false,
};

describe("AccountRequestTransformerDialog", () => {
	it("initializes the rendered selection from the account transformer", () => {
		const html = renderToStaticMarkup(
			<AccountRequestTransformerDialogFields
				account={account}
				onValueChange={() => {}}
			/>,
		);

		expect(html).toContain("Provider Transformer");
		expect(html).toContain("Max Tokens → Max Completion Tokens");
	});

	it("saves the exact transformer ID and closes only after success", async () => {
		let resolveUpdate: (() => void) | undefined;
		const updateFinished = new Promise<void>((resolve) => {
			resolveUpdate = resolve;
		});
		const updateCalls: Array<[string, string | null]> = [];
		const openChanges: boolean[] = [];

		const save = saveAccountRequestTransformerSelection(
			account.id,
			"max-tokens-to-max-completion-tokens",
			async (accountId, value) => {
				updateCalls.push([accountId, value]);
				await updateFinished;
			},
			(open) => openChanges.push(open),
		);

		expect(updateCalls).toEqual([
			["account-1", "max-tokens-to-max-completion-tokens"],
		]);
		expect(openChanges).toEqual([]);

		resolveUpdate?.();
		await save;

		expect(openChanges).toEqual([false]);
	});

	it("saves None as null", async () => {
		const updateCalls: Array<[string, string | null]> = [];

		await saveAccountRequestTransformerSelection(
			account.id,
			REQUEST_TRANSFORMER_NONE_VALUE,
			async (accountId, value) => {
				updateCalls.push([accountId, value]);
			},
			() => {},
		);

		expect(updateCalls).toEqual([["account-1", null]]);
	});

	it("keeps the dialog open when saving is rejected", async () => {
		const openChanges: boolean[] = [];

		await expect(
			saveAccountRequestTransformerSelection(
				account.id,
				"max-tokens-to-max-completion-tokens",
				async () => {
					throw new Error("save failed");
				},
				(open) => openChanges.push(open),
			),
		).rejects.toThrow("save failed");
		expect(openChanges).toEqual([]);
	});
});
