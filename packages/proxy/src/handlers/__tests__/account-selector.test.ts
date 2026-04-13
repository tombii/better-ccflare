import { describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
	setComboSlotInfo,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Test Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function makeCtx(
	opts: { accounts?: Account[]; activeCombo?: ComboWithSlots | null } = {},
): ProxyContext {
	const accounts = opts.accounts ?? [makeAccount()];
	return {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo ?? null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		usageWorker: { postMessage: mock(() => {}) },
	} as unknown as ProxyContext;
}

// ── setComboSlotInfo / getComboSlotInfo ───────────────────────────────────────

describe("setComboSlotInfo / getComboSlotInfo", () => {
	it("stores and retrieves combo slot info on a RequestMeta", () => {
		const meta = makeRequestMeta();
		const info = {
			comboName: "My Combo",
			slots: [{ accountId: "acc-1", modelOverride: "gpt-4" }],
		};
		setComboSlotInfo(meta, info);
		expect(getComboSlotInfo(meta)).toEqual(info);
	});

	it("returns null for a meta that was never set", () => {
		const meta = makeRequestMeta();
		expect(getComboSlotInfo(meta)).toBeNull();
	});

	it("is isolated per RequestMeta object (WeakMap semantics)", () => {
		const meta1 = makeRequestMeta();
		const meta2 = makeRequestMeta();
		setComboSlotInfo(meta1, {
			comboName: "Combo A",
			slots: [{ accountId: "a", modelOverride: "m" }],
		});
		expect(getComboSlotInfo(meta2)).toBeNull();
	});
});

// ── selectAccountsForRequest — forced account via header ──────────────────────

describe("selectAccountsForRequest — x-better-ccflare-account-id header", () => {
	it("returns exactly the forced account when the header matches", async () => {
		const acc1 = makeAccount({ id: "acc-1", name: "first" });
		const acc2 = makeAccount({ id: "acc-2", name: "second" });
		const ctx = makeCtx({ accounts: [acc1, acc2] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-2");
	});

	it("falls through to normal selection when forced account id is not found", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "nonexistent" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Falls back to strategy.select result
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-1");
	});
});

// ── selectAccountsForRequest — combo routing ──────────────────────────────────

describe("selectAccountsForRequest — combo routing", () => {
	it("returns combo-ordered accounts when an active combo exists for the model family", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Both accounts should be returned in slot priority order
		expect(result.map((a) => a.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("stores combo slot info on the RequestMeta when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-5");

		const slotInfo = getComboSlotInfo(meta);
		expect(slotInfo).not.toBeNull();
		expect(slotInfo?.comboName).toBe("Test Combo");
		expect(slotInfo?.slots[0]?.accountId).toBe("acc-1");
		expect(slotInfo?.slots[0]?.modelOverride).toBe("claude-opus-4-5");
	});

	it("sets meta.comboName when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-haiku-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-haiku-4-5");
		expect((meta as any).comboName).toBe("Test Combo");
	});

	it("skips disabled slots", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: false, // disabled
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
	});

	it("falls back to SessionStrategy when all combo slots are rate-limited", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-1",
			rate_limited_until: Date.now() + 3_600_000, // rate limited for 1h
		});
		const fallbackAcc = makeAccount({ id: "acc-fallback" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = {
			strategy: {
				select: mock(() => [fallbackAcc]),
			},
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, fallbackAcc]),
				getActiveComboForFamily: mock(async () => combo),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;

		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// Should fall back to strategy result (fallbackAcc)
		expect(result[0]?.id).toBe("acc-fallback");
	});

	it("falls back to SessionStrategy when no combo is active for the model family", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc], activeCombo: null });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// No combo — strategy.select is used
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("falls back to normal routing when no model is provided", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo lookup for unknown model families", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		// A model that doesn't map to a known family
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"gpt-4-turbo-unknown",
		);
		// getActiveComboForFamily should not be called for unknown families
		const ctxAny = ctx as any;
		expect(ctxAny.dbOps.getActiveComboForFamily).not.toHaveBeenCalled();
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo slots that reference unknown accounts", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-ghost",
				combo_id: "combo-1",
				account_id: "acc-ghost", // does not exist in accounts list
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-real",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Ghost slot is skipped; only acc-1 is returned
		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
	});
});

// ── selectAccountsForRequest — paused account handling ───────────────────────

describe("selectAccountsForRequest — paused accounts in combo", () => {
	it("excludes paused accounts from combo slot results", async () => {
		const pausedAcc = makeAccount({ id: "acc-paused", paused: true });
		const activeAcc = makeAccount({ id: "acc-active" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-paused",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-active",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({
			accounts: [pausedAcc, activeAcc],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-active"]);
	});
});
