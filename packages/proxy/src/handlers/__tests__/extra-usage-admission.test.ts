/**
 * Admission with "use extra usage": a Codex account whose weekly window is
 * spent but which still has purchased credits is served exactly the way the
 * official Codex CLI would be — the upstream keeps answering until the credits
 * run out, at which point its own 429 benches the account through the normal
 * rate-limit path. With the switch off, nothing changes.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { setUseExtraUsage } from "@better-ccflare/core";
import { usageCache } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { selectAccountsForRequest } from "../account-selector";
import { createPoolExhaustedResponse } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

const ACCOUNT_ID = "codex-on-credits";

function codexAccount(): Account {
	return {
		id: ACCOUNT_ID,
		name: "codex",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
	} as Account;
}

function meta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function ctxFor(accounts: Account[]) {
	const select = mock(
		(candidates: Account[], _meta: RequestMeta) => candidates,
	);
	const ctx = {
		strategy: { select },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getModelScopedCapacityRouting: () => "off" },
	} as unknown as ProxyContext;
	return { ctx, select };
}

function seedSpentWeeklyWithCredits() {
	usageCache.set(ACCOUNT_ID, {
		seven_day: {
			utilization: 100,
			resets_at: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(),
		},
		credits: { has_credits: true, unlimited: false, balance: "12" },
	} as never);
}

afterEach(() => {
	setUseExtraUsage(false);
	usageCache.delete(ACCOUNT_ID);
});

describe("selectAccountsForRequest — extra usage", () => {
	it("keeps excluding a spent account while the switch is off", async () => {
		seedSpentWeeklyWithCredits();
		const { ctx, select } = ctxFor([codexAccount()]);

		await selectAccountsForRequest(meta(), ctx);

		expect(select.mock.calls[0]?.[0]).toEqual([]);
	});

	it("admits the same account once extra usage may be spent", async () => {
		seedSpentWeeklyWithCredits();
		setUseExtraUsage(true);
		const { ctx, select } = ctxFor([codexAccount()]);

		await selectAccountsForRequest(meta(), ctx);

		expect(select.mock.calls[0]?.[0]?.map((a: Account) => a.id)).toEqual([
			ACCOUNT_ID,
		]);
	});
});

describe("createPoolExhaustedResponse — extra usage", () => {
	it("does not blame or wait on a usage window that extra usage is serving", async () => {
		const resetMs = Date.now() + 3 * 24 * 3_600_000;
		const snapshot = (extraUsageAvailable?: boolean) =>
			new Map([
				[ACCOUNT_ID, { utilization: 100, resetMs, extraUsageAvailable }],
			]);

		// Control: without extra usage the spent window is the reason, and its
		// three-day reset is what the client is told to wait for.
		const spent = createPoolExhaustedResponse([codexAccount()], snapshot());
		const spentBody = (await spent.json()) as {
			error: {
				accounts: { reason: string; available_at: string | null }[];
				next_available_at: string | null;
			};
		};
		expect(spentBody.error.accounts[0]?.reason).toBe("usage_exhausted");
		expect(spentBody.error.next_available_at).toBe(
			new Date(resetMs).toISOString(),
		);

		// On extra usage the window is not why the pool is empty, so it must not
		// be named as the reason nor push a days-long Retry-After at the client.
		const onCredits = createPoolExhaustedResponse(
			[codexAccount()],
			snapshot(true),
		);
		const body = (await onCredits.json()) as typeof spentBody;
		expect(body.error.accounts[0]?.reason).not.toBe("usage_exhausted");
		expect(body.error.accounts[0]?.available_at).toBeNull();
		expect(body.error.next_available_at).toBeNull();
	});
});
