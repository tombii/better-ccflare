import { describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import { clearCodexModelCacheForTests } from "../../codex-model-catalog";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// "Force account model" is a promise about the model, not about the account:
// the request may move between accounts freely, and may never be served by an
// account that would send a different model.

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
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

function makeCtx(opts: {
	accounts: Account[];
	forceAccountModel: boolean;
	combo?: ComboWithSlots | null;
}) {
	const getActiveComboForFamily = mock(async () => opts.combo ?? null);
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
		config: {
			getForceAccountModel: () => opts.forceAccountModel,
			getCombosEnabled: () => true,
		},
	} as unknown as ProxyContext;
	return { ctx, getActiveComboForFamily };
}

const claudeAccount = makeAccount({ id: "claude-1", provider: "anthropic" });
const codexAccount = makeAccount({ id: "codex-1", provider: "codex" });

describe("selectAccountsForRequest — force account model", () => {
	it("sends a provider model id only to accounts of that provider", async () => {
		clearCodexModelCacheForTests();
		const { ctx } = makeCtx({
			accounts: [claudeAccount, codexAccount],
			forceAccountModel: true,
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-5.6-sol",
		);

		expect(result.map((a) => a.id)).toEqual(["codex-1"]);
	});

	it("sends a Claude model id only to accounts that speak Claude ids", async () => {
		clearCodexModelCacheForTests();
		const { ctx } = makeCtx({
			accounts: [claudeAccount, codexAccount],
			forceAccountModel: true,
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-1",
		);

		expect(result.map((a) => a.id)).toEqual(["claude-1"]);
	});

	it("keeps every account that can serve the model, so failover still works", async () => {
		clearCodexModelCacheForTests();
		const second = makeAccount({ id: "codex-2", provider: "codex" });
		const { ctx } = makeCtx({
			accounts: [codexAccount, second],
			forceAccountModel: true,
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-5.6-sol",
		);

		// Moving between accounts is allowed — it is moving between models that
		// this setting forbids.
		expect(result.map((a) => a.id)).toEqual(["codex-1", "codex-2"]);
	});

	it("returns nothing rather than an account that would send another model", async () => {
		clearCodexModelCacheForTests();
		const { ctx } = makeCtx({
			accounts: [claudeAccount],
			forceAccountModel: true,
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-5.6-sol",
		);

		expect(result).toEqual([]);
	});

	it("never routes through a combo, since a slot exists to change the model", async () => {
		clearCodexModelCacheForTests();
		const combo: ComboWithSlots = {
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
					account_id: "codex-1",
					model: "gpt-5.6-sol",
					priority: 0,
					enabled: true,
				},
			],
		};
		const { ctx, getActiveComboForFamily } = makeCtx({
			accounts: [claudeAccount, codexAccount],
			forceAccountModel: true,
			combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-1");

		expect(getActiveComboForFamily).not.toHaveBeenCalled();
		expect(getComboSlotInfo(meta)).toBeNull();
		// The combo would have sent this to the codex account as gpt-5.6-sol.
		expect(result.map((a) => a.id)).toEqual(["claude-1"]);
	});

	it("changes nothing while off", async () => {
		clearCodexModelCacheForTests();
		const { ctx } = makeCtx({
			accounts: [claudeAccount, codexAccount],
			forceAccountModel: false,
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-5.6-sol",
		);

		expect(result.map((a) => a.id)).toEqual(["claude-1", "codex-1"]);
	});
});

/**
 * `x-better-ccflare-account-id` names an account outright, and that path
 * returns before every other filter. Under this setting it still has to answer
 * the one question the setting is about, because the two ways of not answering
 * it are both worse: falling through to normal selection would send the request
 * to a *different* account than the header named, and letting it through would
 * put an account that can never serve this model in front of the capacity
 * branches, which would then advertise a retry time for a wait that can never
 * help.
 */
describe("selectAccountsForRequest — force account model, forced-account header", () => {
	function metaForcing(accountId: string): RequestMeta {
		return {
			...makeRequestMeta(),
			headers: new Headers({ "x-better-ccflare-account-id": accountId }),
		};
	}

	it("refuses when the named account cannot serve the model as written", async () => {
		clearCodexModelCacheForTests();
		const { ctx } = makeCtx({
			accounts: [claudeAccount, codexAccount],
			forceAccountModel: true,
		});

		const result = await selectAccountsForRequest(
			metaForcing("codex-1"),
			ctx,
			"claude-opus-4-1",
		);

		// Empty, which proxy.ts answers as force_account_model_no_account —
		// and specifically not [claude-1], which would be the account swap.
		expect(result).toEqual([]);
	});

	it("still honours the header when the named account can serve the model", async () => {
		clearCodexModelCacheForTests();
		const { ctx } = makeCtx({
			accounts: [claudeAccount, codexAccount],
			forceAccountModel: true,
		});

		const result = await selectAccountsForRequest(
			metaForcing("codex-1"),
			ctx,
			"gpt-5.6-sol",
		);

		expect(result.map((a) => a.id)).toEqual(["codex-1"]);
	});

	it("leaves the header alone while off", async () => {
		clearCodexModelCacheForTests();
		const { ctx } = makeCtx({
			accounts: [claudeAccount, codexAccount],
			forceAccountModel: false,
		});

		const result = await selectAccountsForRequest(
			metaForcing("codex-1"),
			ctx,
			"claude-opus-4-1",
		);

		expect(result.map((a) => a.id)).toEqual(["codex-1"]);
	});
});
