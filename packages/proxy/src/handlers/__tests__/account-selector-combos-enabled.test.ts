import { describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// The combos switch decides whether combo routing runs at all. Before it
// existed, BETTER_CCFLARE_SHOW_COMBOS hid the dashboard tab and nothing else,
// so a hidden combo kept steering traffic — these tests pin the switch to
// routing, not to visibility.

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
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
		...overrides,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeCombo(accountId: string, model: string): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Opus Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots: [
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: accountId,
				model,
				priority: 0,
				enabled: true,
			},
		],
	};
}

function makeCtx(opts: {
	accounts: Account[];
	combo: ComboWithSlots | null;
	/** undefined models a context built without a config, as callers/tests do. */
	combosEnabled?: boolean;
}) {
	const getActiveComboForFamily = mock(async () => opts.combo);
	const ctx = {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => opts.accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => opts.accounts),
			getActiveComboForFamily,
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		...(opts.combosEnabled === undefined
			? {}
			: { config: { getCombosEnabled: () => opts.combosEnabled } }),
	} as unknown as ProxyContext;
	return { ctx, getActiveComboForFamily };
}

describe("selectAccountsForRequest — combos switch", () => {
	it("routes through the combo when combos are enabled", async () => {
		const account = makeAccount({ id: "acc-combo" });
		const { ctx, getActiveComboForFamily } = makeCtx({
			accounts: [account],
			combo: makeCombo("acc-combo", "claude-opus-4"),
			combosEnabled: true,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4");

		expect(getActiveComboForFamily).toHaveBeenCalled();
		expect(result.map((a) => a.id)).toEqual(["acc-combo"]);
		expect(getComboSlotInfo(meta)?.comboName).toBe("Opus Combo");
	});

	it("never looks a combo up when combos are disabled", async () => {
		const account = makeAccount({ id: "acc-combo" });
		const { ctx, getActiveComboForFamily } = makeCtx({
			accounts: [account],
			combo: makeCombo("acc-combo", "claude-opus-4"),
			combosEnabled: false,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4");

		// The combo exists in the database and is deliberately ignored: the
		// request goes through normal pool routing, and no combo state is left
		// on the meta for downstream code to act on.
		expect(getActiveComboForFamily).not.toHaveBeenCalled();
		expect(getComboSlotInfo(meta)).toBeNull();
		expect(result.map((a) => a.id)).toEqual(["acc-combo"]);
	});

	it("keeps routing through combos when the context has no config at all", async () => {
		// A missing config means there is no operator to ask — not that the
		// feature is off. Treating it as off here would silently disable combo
		// routing for every caller that builds a context without one.
		const account = makeAccount({ id: "acc-combo" });
		const { ctx, getActiveComboForFamily } = makeCtx({
			accounts: [account],
			combo: makeCombo("acc-combo", "claude-opus-4"),
		});

		await selectAccountsForRequest(makeRequestMeta(), ctx, "claude-opus-4");

		expect(getActiveComboForFamily).toHaveBeenCalled();
	});
});
