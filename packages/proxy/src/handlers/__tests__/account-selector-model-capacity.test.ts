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
		// Overage confirmed unavailable — without this the tri-state resolver
		// reports "unknown" and the capacity filter correctly fails open.
		spend: { enabled: false },
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

	// v3 S8: capacity routing off must leave a pre-populated negative cache
	// entirely without effect — exact today's behavior.
	it("ignores a pre-populated negative cache entry when capacity routing is off", async () => {
		const acc = makeAccount({ id: "acc-1" });
		markFamilyExhausted(acc.id, "fable", Date.now() + 60_000);
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "off" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
		expect(getModelFamilyExhaustionInfo(meta)).toBeNull();
	});
});

// ── v3 Revision v2 Fix3 (codex-1/2): skipCombo option ───────────────────────────
//
// Step 10 in proxy.ts re-selects after every combo slot has failed. Passing
// only the model would re-trigger the SAME combo lookup (the combo lookup is
// keyed purely on the model's family, not on requestMeta.comboName — clearing
// comboName does NOT make the branch inert). skipCombo makes the combo branch
// an explicit no-op so Step 10 falls straight into normal (capacity-filtered)
// routing instead of re-selecting the already-failed combo.

describe("selectAccountsForRequest — skipCombo option (v3 Fix3)", () => {
	it("does not perform a combo lookup at all when skipCombo is true, even though an active combo exists for the family", async () => {
		const comboAcc = makeAccount({ id: "acc-combo" });
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
		const ctx = makeCtx({
			accounts: [comboAcc],
			activeCombo: combo,
			capacityRoutingMode: "off",
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
			{ skipCombo: true },
		);

		expect(
			(ctx.dbOps.getActiveComboForFamily as ReturnType<typeof mock>).mock.calls
				.length,
		).toBe(0);
		// Falls straight to normal (strategy-driven) routing.
		expect(result.map((a) => a.id)).toEqual(["acc-combo"]);
	});

	it("applies the capacity filter on the skipCombo path using the passed model", async () => {
		const exhausted = makeAccount({ id: "acc-exhausted" });
		usageCache.set(exhausted.id, exhaustedUsage("Sonnet", Date.now()));
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-exhausted",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [exhausted],
			activeCombo: combo,
			capacityRoutingMode: "exhausted",
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
			{ skipCombo: true },
		);

		expect(result).toHaveLength(0);
		expect(getModelFamilyExhaustionInfo(meta)?.family).toBe("sonnet");
	});
});

// ── v3 S4 (integration level): overage tri-state ────────────────────────────────

describe("selectAccountsForRequest — overage tri-state (integration)", () => {
	function scopedUsageWithOverage(
		displayName: string,
		now: number,
		overage?: { extraUsageEnabled?: boolean; spendEnabled?: boolean },
	) {
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
			...(overage?.extraUsageEnabled !== undefined
				? {
						extra_usage: {
							is_enabled: overage.extraUsageEnabled,
							monthly_limit: null,
							used_credits: null,
							utilization: null,
						},
					}
				: {}),
			...(overage?.spendEnabled !== undefined
				? { spend: { enabled: overage.spendEnabled } }
				: {}),
		} as never;
	}

	it("keeps an account routable when overage is available (extra_usage.is_enabled=true)", async () => {
		const acc = makeAccount({ id: "acc-overage-available" });
		usageCache.set(
			acc.id,
			scopedUsageWithOverage("Fable", Date.now(), { extraUsageEnabled: true }),
		);
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((a) => a.id)).toEqual(["acc-overage-available"]);
	});

	it("excludes an account when overage is explicitly unavailable (extra_usage.is_enabled=false)", async () => {
		const acc = makeAccount({ id: "acc-overage-unavailable" });
		usageCache.set(
			acc.id,
			scopedUsageWithOverage("Fable", Date.now(), { extraUsageEnabled: false }),
		);
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toHaveLength(0);
	});

	it("fails open (keeps the account) when overage status is unknown (no extra_usage, no spend block)", async () => {
		const acc = makeAccount({ id: "acc-overage-unknown" });
		usageCache.set(acc.id, scopedUsageWithOverage("Fable", Date.now()));
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((a) => a.id)).toEqual(["acc-overage-unknown"]);
	});
});

// ── v3 S8/codex-6 (integration level): two scoped rows for the same family ───────

describe("selectAccountsForRequest — multiple weekly_scoped rows for the same family", () => {
	it("fails open when only one of two same-family rows is exhausted", async () => {
		const acc = makeAccount({ id: "acc-two-rows" });
		const now = Date.now();
		usageCache.set(acc.id, {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
					scope: { model: { id: null, display_name: "Fable" }, surface: "cli" },
				},
				{
					kind: "weekly_scoped",
					percent: 40,
					resets_at: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
					scope: { model: { id: null, display_name: "Fable" }, surface: "api" },
				},
			],
		} as never);
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((a) => a.id)).toEqual(["acc-two-rows"]);
	});
});

// ── v3 Revision v2 Fix1: signal provenance surfaced on the exhaustion info ────────

describe("selectAccountsForRequest — exhaustion signal provenance", () => {
	it("reports origin 'telemetry_confirmed' when exhaustion comes from cached usage telemetry", async () => {
		const acc = makeAccount({ id: "acc-telemetry" });
		usageCache.set(acc.id, exhaustedUsage("Fable", Date.now()));
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toHaveLength(0);
		expect(getModelFamilyExhaustionInfo(meta)?.origin).toBe(
			"telemetry_confirmed",
		);
	});

	it("reports origin 'recent_upstream_rejection' when exhaustion comes only from the reactive negative cache", async () => {
		const acc = makeAccount({ id: "acc-reactive" });
		markFamilyExhausted(acc.id, "sonnet", Date.now() + 60_000);
		const ctx = makeCtx({ accounts: [acc], capacityRoutingMode: "exhausted" });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result).toHaveLength(0);
		expect(getModelFamilyExhaustionInfo(meta)?.origin).toBe(
			"recent_upstream_rejection",
		);
	});

	// v3 Revision v2 Fix3: strictest origin wins when the excluded accounts
	// disagree on provenance — a mix of telemetry-confirmed and reactive-only
	// exclusions must not claim "weekly capacity exhausted" for the whole
	// family, since at least one of those accounts was never corroborated by
	// telemetry.
	it("reports origin 'recent_upstream_rejection' when excluded accounts have mixed provenance (strictest origin wins)", async () => {
		const telemetryAcc = makeAccount({ id: "acc-mixed-telemetry" });
		const reactiveAcc = makeAccount({ id: "acc-mixed-reactive" });
		usageCache.set(telemetryAcc.id, exhaustedUsage("Fable", Date.now()));
		markFamilyExhausted(reactiveAcc.id, "fable", Date.now() + 60_000);
		const ctx = makeCtx({
			accounts: [telemetryAcc, reactiveAcc],
			capacityRoutingMode: "exhausted",
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toHaveLength(0);
		expect(getModelFamilyExhaustionInfo(meta)?.origin).toBe(
			"recent_upstream_rejection",
		);
	});

	// codex branch-review finding 3: with mixed provenance, Retry-After must
	// reflect the EARLIEST point any excluded account becomes eligible again —
	// the reactive mark's 60s expiry here, not the telemetry account's
	// 3-day scoped reset.
	it("aggregates the earliest recovery time across telemetry resets AND negative-cache expiries", async () => {
		const now = Date.now();
		const telemetryAcc = makeAccount({ id: "acc-agg-telemetry" });
		const reactiveAcc = makeAccount({ id: "acc-agg-reactive" });
		usageCache.set(telemetryAcc.id, exhaustedUsage("Fable", now));
		const reactiveUntil = now + 60_000;
		markFamilyExhausted(reactiveAcc.id, "fable", reactiveUntil);
		const ctx = makeCtx({
			accounts: [telemetryAcc, reactiveAcc],
			capacityRoutingMode: "exhausted",
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toHaveLength(0);
		const info = getModelFamilyExhaustionInfo(meta);
		expect(info?.resetAt).toBe(reactiveUntil);
	});
});
