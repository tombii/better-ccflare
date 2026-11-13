/**
 * The four account-side enforcement seams for per-API-key restrictions.
 *
 * Each one exists because there is a distinct path from a request to an
 * account, and a restriction that covers only some of them is not a
 * restriction — it is a suggestion:
 *
 *   Seam 1  the ordinary pool, filtered before any strategy sees it
 *   Seam 2  the x-better-ccflare-account-id header, which returns early
 *   Seam 3  combo slots, which read getAllAccounts() independently
 *   Seam 4  the cooldown-masking sweep, which walks the raw unfiltered list
 *
 * Plus the two carve-outs that must stay no-ops: verified internal probes, and
 * zero-keys mode (no API key at all).
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ApiKeyRestrictions,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getComboSlotInfo,
	getDeferredCandidates,
	getModelFamilyExhaustionInfo,
	selectAccountsForRequest,
} from "../account-selector";
import { getApiKeyRestrictionDenial } from "../api-key-restrictions";
import { clearFamilyExhaustionCache } from "../model-capacity";
import {
	INTERNAL_PROBE_SECRET_HEADER,
	type ProxyContext,
} from "../proxy-types";

const SECRET = "probe-secret-for-tests";

afterEach(() => {
	delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
	usageCache.clear();
	clearFamilyExhaustionCache();
});

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
	} as unknown as Account;
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

/**
 * A context whose strategy is a pass-through: it returns exactly what it is
 * handed. That is what makes the seam-1 assertions meaningful — anything
 * missing from the result was removed BEFORE the strategy, which is the whole
 * claim seam 1 makes.
 */
function makeCtx(
	opts: { accounts?: Account[]; activeCombo?: ComboWithSlots | null } = {},
): ProxyContext {
	const accounts = opts.accounts ?? [makeAccount()];
	return {
		strategy: {
			select: mock((candidates: Account[], _meta: RequestMeta) => candidates),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo ?? null),
		},
		internalProbeSecret: SECRET,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
}

function restrictions(
	overrides: Partial<ApiKeyRestrictions> = {},
): ApiKeyRestrictions {
	return {
		allowedAccounts: null,
		allowedModels: null,
		allowedProviders: null,
		...overrides,
	};
}

// ── Seam 1: the ordinary pool ─────────────────────────────────────────────────

describe("seam 1 — account pool filter, before the strategy", () => {
	it("keeps only the accounts the key is allowed", async () => {
		const ctx = makeCtx({
			accounts: [
				makeAccount({ id: "acc-1" }),
				makeAccount({ id: "acc-2" }),
				makeAccount({ id: "acc-3" }),
			],
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			undefined,
			{ restrictions: restrictions({ allowedAccounts: ["acc-2"] }) },
		);

		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
	});

	it("filters before the strategy runs, not after", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		await selectAccountsForRequest(makeRequestMeta(), ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: ["acc-2"] }),
		});

		// The strategy never even saw acc-1 — a session strategy handed the full
		// pool could otherwise pick a sticky account this key may not use.
		const select = ctx.strategy.select as unknown as {
			mock: { calls: Array<[Account[], RequestMeta]> };
		};
		expect(select.mock.calls[0][0].map((account) => account.id)).toEqual([
			"acc-2",
		]);
	});

	it("keeps only the providers the key is allowed", async () => {
		const ctx = makeCtx({
			accounts: [
				makeAccount({ id: "acc-1", provider: "anthropic" }),
				makeAccount({ id: "acc-2", provider: "zai" }),
			],
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			undefined,
			{ restrictions: restrictions({ allowedProviders: ["zai"] }) },
		);

		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
	});

	it("denies every account for a deny-all empty list", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			undefined,
			{ restrictions: restrictions({ allowedAccounts: [] }) },
		);

		expect(result).toEqual([]);
	});

	it("records a policy denial when the restriction empties the pool", async () => {
		const meta = makeRequestMeta();
		const ctx = makeCtx({ accounts: [makeAccount({ id: "acc-1" })] });

		await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: ["acc-nope"] }),
		});

		const denial = getApiKeyRestrictionDenial(meta);
		expect(denial?.scope).toBe("accounts");
		expect(denial?.removed).toBe(1);
	});

	it("records no denial when the pool was already empty for other reasons", async () => {
		const meta = makeRequestMeta();
		const ctx = makeCtx({ accounts: [] });

		await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: ["acc-1"] }),
		});

		// Nothing was restricted away — there was nothing there. That is
		// capacity, and must keep answering as pool_exhausted.
		expect(getApiKeyRestrictionDenial(meta)).toBeNull();
	});

	it("names both lists when both narrowed the pool", async () => {
		const meta = makeRequestMeta();
		const ctx = makeCtx({ accounts: [makeAccount({ id: "acc-1" })] });

		await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({
				allowedAccounts: ["acc-9"],
				allowedProviders: ["zai"],
			}),
		});

		expect(getApiKeyRestrictionDenial(meta)?.scope).toBe(
			"accounts and providers",
		);
	});
});

// ── Seam 2: the forced-account header ─────────────────────────────────────────

describe("seam 2 — x-better-ccflare-account-id must not bypass the allowlist", () => {
	it("refuses a forced account the key is not allowed", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: ["acc-1"] }),
		});

		// Refused outright — NOT quietly served by acc-1, which would be
		// substituting a different account than the header named.
		expect(result).toEqual([]);
		const denial = getApiKeyRestrictionDenial(meta);
		expect(denial?.scope).toBe("forced account");
		expect(denial?.forcedAccountName).toBe("test-account");
	});

	it("refuses a forced account whose provider the key is not allowed", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});
		const ctx = makeCtx({
			accounts: [
				makeAccount({ id: "acc-1", provider: "zai" }),
				makeAccount({ id: "acc-2", provider: "anthropic" }),
			],
		});

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedProviders: ["zai"] }),
		});

		expect(result).toEqual([]);
		expect(getApiKeyRestrictionDenial(meta)?.scope).toBe("forced account");
	});

	it("still honours a forced account the key IS allowed", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: ["acc-2"] }),
		});

		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
		expect(getApiKeyRestrictionDenial(meta)).toBeNull();
	});
});

// ── Seam 3: combo slots ───────────────────────────────────────────────────────

describe("seam 3 — combo slots must not bypass the allowlist", () => {
	it("drops combo slots pointing at accounts the key is not allowed", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		const ctx = makeCtx({
			accounts,
			activeCombo: makeCombo([
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: "acc-1",
					model: "",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-2",
					combo_id: "combo-1",
					account_id: "acc-2",
					model: "",
					priority: 1,
					enabled: true,
				},
			] as unknown as ComboWithSlots["slots"]),
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-5",
			{ restrictions: restrictions({ allowedAccounts: ["acc-2"] }) },
		);

		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
	});

	it("falls through to normal routing when every slot is restricted away", async () => {
		// The fallthrough re-applies seam 1, so a combo whose slots are all
		// disallowed can never become a way around the allowlist.
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		const ctx = makeCtx({
			accounts,
			activeCombo: makeCombo([
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: "acc-1",
					model: "",
					priority: 0,
					enabled: true,
				},
			] as unknown as ComboWithSlots["slots"]),
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-5",
			{ restrictions: restrictions({ allowedAccounts: ["acc-2"] }) },
		);

		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
	});

	it("denies everything when a combo's slots and the pool are both restricted away", async () => {
		const meta = makeRequestMeta();
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" })],
			activeCombo: makeCombo([
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: "acc-1",
					model: "",
					priority: 0,
					enabled: true,
				},
			] as unknown as ComboWithSlots["slots"]),
		});

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-opus-4-5",
			{
				restrictions: restrictions({ allowedAccounts: [] }),
			},
		);

		expect(result).toEqual([]);
		expect(getApiKeyRestrictionDenial(meta)?.scope).toBe("accounts");
	});
});

// ── Carve-out: verified internal probes ───────────────────────────────────────

describe("carve-out — internal probes are exempt", () => {
	it("lets a verified auto-refresh probe reach a restricted-away account", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-auto-refresh": "true",
			}),
		});
		const ctx = makeCtx({ accounts: [makeAccount({ id: "acc-1" })] });

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: [] }),
		});

		// A probe refused by a routing rule reads as a refresh failure, and five
		// of those pause a perfectly healthy account.
		expect(result.map((account) => account.id)).toEqual(["acc-1"]);
		expect(getApiKeyRestrictionDenial(meta)).toBeNull();
	});

	it("lets a verified keepalive probe through too", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-keepalive": "true",
			}),
		});
		const ctx = makeCtx({ accounts: [makeAccount({ id: "acc-1" })] });

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedProviders: [] }),
		});

		expect(result.map((account) => account.id)).toEqual(["acc-1"]);
	});

	it("does NOT exempt a marker header without the process-local secret", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({
				[INTERNAL_PROBE_SECRET_HEADER]: "copied-from-a-log",
				"x-better-ccflare-auto-refresh": "true",
			}),
		});
		const ctx = makeCtx({ accounts: [makeAccount({ id: "acc-1" })] });

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: [] }),
		});

		expect(result).toEqual([]);
	});

	it("does NOT exempt the client-settable bypass-session header", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-bypass-session": "true" }),
		});
		const ctx = makeCtx({ accounts: [makeAccount({ id: "acc-1" })] });

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedAccounts: [] }),
		});

		expect(result).toEqual([]);
	});
});

// ── Carve-out: zero-keys mode / unrestricted keys ─────────────────────────────

describe("carve-out — zero-keys mode and unrestricted keys are no-ops", () => {
	it("is a no-op when no restrictions are passed at all (zero-keys mode)", async () => {
		const meta = makeRequestMeta();
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		const result = await selectAccountsForRequest(meta, ctx);

		expect(result.map((account) => account.id)).toEqual(["acc-1", "acc-2"]);
		expect(getApiKeyRestrictionDenial(meta)).toBeNull();
	});

	it("is a no-op for an explicit null (authenticated but unrestricted)", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			undefined,
			{ restrictions: null },
		);

		expect(result.map((account) => account.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("is a no-op for a key with all three lists NULL", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			undefined,
			{ restrictions: restrictions() },
		);

		expect(result.map((account) => account.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("leaves the forced-account header working for an unrestricted key", async () => {
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});

		const result = await selectAccountsForRequest(meta, ctx, undefined, {
			restrictions: restrictions({ allowedModels: ["opus"] }),
		});

		// A model-only restriction narrows no account pool; the header still works.
		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
	});
});

// ── Seam 4: the cooldown-masking sweep ────────────────────────────────────────

// A weekly_scoped usage payload with a fully exhausted cap for `displayName`'s
// family, resetting well in the future. Same shape as
// account-selector-model-capacity.test.ts.
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
		spend: { enabled: false },
	} as never;
}

describe("seam 4 — the cooldown-masking sweep skips restricted-away accounts", () => {
	it("does not blame an account this key may not use for the request being blocked", async () => {
		const now = Date.now();
		// Permitted, and genuinely out of weekly capacity for this family.
		const exhaustedAcc = makeAccount({ id: "acc-allowed" });
		usageCache.set(exhaustedAcc.id, exhaustedUsage("Fable", now));
		// NOT permitted for this key, has free capacity, and is sidelined only
		// by a 90-second cooldown. Unfiltered, the sweep would call it the real
		// blocker and hand the caller a Retry-After for an account that will
		// never serve them.
		const restrictedCooldownAcc = makeAccount({
			id: "acc-forbidden",
			rate_limited_until: now + 90_000,
		});
		const ctx = {
			strategy: { select: mock(() => [exhaustedAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [exhaustedAcc, restrictedCooldownAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			internalProbeSecret: SECRET,
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			config: { getModelScopedCapacityRouting: () => "exhausted" },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5", {
			restrictions: restrictions({ allowedAccounts: ["acc-allowed"] }),
		});

		expect(result).toHaveLength(0);
		const info = getModelFamilyExhaustionInfo(meta);
		expect(info?.origin).toBe("telemetry_confirmed");
		expect(info?.resetAt).not.toBe(restrictedCooldownAcc.rate_limited_until);
	});

	it("still reports cooldown_masked for a PERMITTED account on a cooldown", async () => {
		const now = Date.now();
		const exhaustedAcc = makeAccount({ id: "acc-allowed" });
		usageCache.set(exhaustedAcc.id, exhaustedUsage("Fable", now));
		const cooldownAcc = makeAccount({
			id: "acc-also-allowed",
			rate_limited_until: now + 90_000,
		});
		const ctx = {
			strategy: { select: mock(() => [exhaustedAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [exhaustedAcc, cooldownAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			internalProbeSecret: SECRET,
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			config: { getModelScopedCapacityRouting: () => "exhausted" },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5", {
			restrictions: restrictions({
				allowedAccounts: ["acc-allowed", "acc-also-allowed"],
			}),
		});

		// The restriction narrowed nothing here, so the pre-existing
		// cooldown-masking diagnosis must survive untouched.
		expect(result).toHaveLength(0);
		expect(getModelFamilyExhaustionInfo(meta)?.origin).toBe("cooldown_masked");
	});
});

// ── Vision deferrals: a restricted-away account is never "deferred" ──────────

describe("deferred candidates exclude accounts the key may not use", () => {
	it("does not record a restricted-away pool account as deferred", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-opus-4-5",
			{ restrictions: restrictions({ allowedAccounts: ["acc-2"] }) },
		);

		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
		// acc-1 is permanently ineligible for this key, so it must not hold a
		// terminal vision verdict open as if it might serve the request later.
		expect(
			getDeferredCandidates(meta).map((candidate) => candidate.accountId),
		).not.toContain("acc-1");
	});

	it("does not record a restricted-away combo slot as deferred", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "acc-1" }), makeAccount({ id: "acc-2" })],
			activeCombo: makeCombo([
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: "acc-1",
					model: "",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-2",
					combo_id: "combo-1",
					account_id: "acc-2",
					model: "",
					priority: 1,
					enabled: true,
				},
			] as unknown as ComboWithSlots["slots"]),
		});
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-5", {
			restrictions: restrictions({ allowedAccounts: ["acc-2"] }),
		});

		expect(
			getDeferredCandidates(meta).map((candidate) => candidate.accountId),
		).not.toContain("acc-1");
	});
});

describe("API key family combo overrides", () => {
	it("routes opus through that key's Codex combo while other keys use the global combo", async () => {
		const accounts = [
			makeAccount({ id: "anthropic", provider: "anthropic" }),
			makeAccount({ id: "codex", provider: "codex" }),
		];
		const globalCombo = makeCombo([
			{
				id: "global-slot",
				combo_id: "combo-1",
				account_id: "anthropic",
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const overrideCombo = {
			...makeCombo([
				{
					id: "sol-slot",
					combo_id: "sol-combo",
					account_id: "codex",
					model: "gpt-sol",
					priority: 0,
					enabled: true,
				},
			]),
			id: "sol-combo",
			name: "GPT Sol",
		};
		const ctx = makeCtx({ accounts, activeCombo: globalCombo });
		Object.assign(ctx.dbOps, {
			getCombo: mock(async () => overrideCombo),
			getComboSlots: mock(async () => overrideCombo.slots),
		});
		const overridden = makeRequestMeta({ id: "key-with-override" });
		expect(
			(
				await selectAccountsForRequest(overridden, ctx, "claude-opus-4-5", {
					familyComboOverrides: { opus: "sol-combo" },
				})
			).map((account) => account.id),
		).toEqual(["codex"]);
		expect(getComboSlotInfo(overridden)?.comboName).toBe("GPT Sol");
		const ordinary = makeRequestMeta({ id: "other-key" });
		expect(
			(await selectAccountsForRequest(ordinary, ctx, "claude-opus-4-5")).map(
				(account) => account.id,
			),
		).toEqual(["anthropic"]);
		expect(getComboSlotInfo(ordinary)?.comboName).toBe("Test Combo");
	});
	it("still applies provider restrictions to an overridden combo", async () => {
		const account = makeAccount({ id: "codex", provider: "codex" });
		const combo = {
			...makeCombo([
				{
					id: "sol-slot",
					combo_id: "sol-combo",
					account_id: "codex",
					model: "gpt-sol",
					priority: 0,
					enabled: true,
				},
			]),
			id: "sol-combo",
		};
		const ctx = makeCtx({ accounts: [account] });
		Object.assign(ctx.dbOps, {
			getCombo: mock(async () => combo),
			getComboSlots: mock(async () => combo.slots),
		});
		const selected = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-5",
			{
				familyComboOverrides: { opus: "sol-combo" },
				restrictions: restrictions({ allowedProviders: ["anthropic"] }),
			},
		);
		expect(selected).toEqual([]);
	});
});
