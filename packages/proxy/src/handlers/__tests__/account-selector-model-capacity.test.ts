import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getModelFamilyExhaustionInfo,
	selectAccountsForRequest,
} from "../account-selector";
import {
	clearFamilyExhaustionCache,
	markFamilyExhausted,
} from "../model-capacity";
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
		auto_pause_on_overage_enabled: false,
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
	opts: {
		accounts?: Account[];
		activeCombo?: ComboWithSlots | null;
		capacityRoutingMode?: "off" | "exhausted";
	} = {},
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
		config: {
			getModelScopedCapacityRouting: () => opts.capacityRoutingMode ?? "off",
		},
	} as unknown as ProxyContext;
}

// A weekly_scoped usage payload with a fully exhausted cap for `displayName`'s
// family, with a reset far in the future.
function exhaustedUsage(displayName: string, now: number) {
	return {
		limits: [
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
				scope: {
					model: { id: null, display_name: displayName },
					surface: null,
				},
			},
		],
	} as never;
}

afterEach(() => {
	usageCache.clear();
	clearFamilyExhaustionCache();
});

// ── telemetry-based exhaustion ──────────────────────────────────────────────────

describe("selectAccountsForRequest — model-scoped capacity filter (telemetry)", () => {
	it("excludes an account whose Fable cap is exhausted for a Fable request", async () => {
		const acc = makeAccount({ id: "acc-fable" });
		usageCache.set(acc.id, exhaustedUsage("Fable", Date.now()));
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toHaveLength(0);
		expect(getModelFamilyExhaustionInfo(meta)?.family).toBe("fable");
	});

	it("does NOT exclude the same account for a Sonnet request (different family)", async () => {
		const acc = makeAccount({ id: "acc-fable" });
		usageCache.set(acc.id, exhaustedUsage("Fable", Date.now()));
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((a) => a.id)).toEqual(["acc-fable"]);
		expect(getModelFamilyExhaustionInfo(meta)).toBeNull();
	});

	it("keeps a non-exhausted account in the pool alongside an excluded one", async () => {
		const exhausted = makeAccount({ id: "acc-exhausted" });
		const healthy = makeAccount({ id: "acc-healthy" });
		usageCache.set(exhausted.id, exhaustedUsage("Fable", Date.now()));
		const ctx = makeCtx({
			accounts: [exhausted, healthy],
			capacityRoutingMode: "exhausted",
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((a) => a.id)).toEqual(["acc-healthy"]);
		expect(getModelFamilyExhaustionInfo(meta)).toBeNull();
	});
});

// ── negative cache (out_of_credits-fed) exhaustion ──────────────────────────────

describe("selectAccountsForRequest — model-scoped capacity filter (negative cache)", () => {
	it("excludes an account recently marked exhausted via markFamilyExhausted, even with no usage telemetry", async () => {
		const acc = makeAccount({ id: "acc-1" });
		markFamilyExhausted(acc.id, "sonnet", Date.now() + 60_000);
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result).toHaveLength(0);
		expect(getModelFamilyExhaustionInfo(meta)?.family).toBe("sonnet");
	});
});

// ── combo-slot filtering ─────────────────────────────────────────────────────────

describe("selectAccountsForRequest — model-scoped capacity filter (combo routing)", () => {
	it("filters a combo slot whose own model override is exhausted", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		usageCache.set(acc1.id, exhaustedUsage("Sonnet", Date.now()));
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
		const ctx = makeCtx({
			accounts: [acc1, acc2],
			activeCombo: combo,
			capacityRoutingMode: "exhausted",
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// Only the non-exhausted slot (acc-2) is returned; the combo pool isn't
		// fully empty so no fallback and no exhaustion signal.
		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
	});

	it("falls back to SessionStrategy when every combo slot is exhausted", async () => {
		const comboAcc = makeAccount({ id: "acc-combo" });
		const fallbackAcc = makeAccount({ id: "acc-fallback" });
		usageCache.set(comboAcc.id, exhaustedUsage("Sonnet", Date.now()));
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-combo",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [fallbackAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [comboAcc, fallbackAcc]),
				getActiveComboForFamily: mock(async () => combo),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			config: { getModelScopedCapacityRouting: () => "exhausted" },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((a) => a.id)).toEqual(["acc-fallback"]);
	});
});

// ── force-header bypass ──────────────────────────────────────────────────────────

describe("selectAccountsForRequest — model-scoped capacity filter (force-header bypass)", () => {
	it("returns the forced account even when it is exhausted for the request's family", async () => {
		const acc = makeAccount({ id: "acc-forced" });
		usageCache.set(acc.id, exhaustedUsage("Fable", Date.now()));
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-forced" }),
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-forced");
	});
});

// ── switch off ─────────────────────────────────────────────────────────────────

describe("selectAccountsForRequest — model-scoped capacity filter (switch off)", () => {
	it("does not filter when capacity routing is off (default)", async () => {
		const acc = makeAccount({ id: "acc-exhausted" });
		usageCache.set(acc.id, exhaustedUsage("Fable", Date.now()));
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "off" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((a) => a.id)).toEqual(["acc-exhausted"]);
		expect(getModelFamilyExhaustionInfo(meta)).toBeNull();
	});

	it("does not filter when ctx.config is absent (defensive default)", async () => {
		const acc = makeAccount({ id: "acc-exhausted" });
		usageCache.set(acc.id, exhaustedUsage("Fable", Date.now()));
		const ctx = {
			strategy: { select: mock(() => [acc]) },
			dbOps: {
				getAllAccounts: mock(async () => [acc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((a) => a.id)).toEqual(["acc-exhausted"]);
	});
});
