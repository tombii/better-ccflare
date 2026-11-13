import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import { Logger } from "@better-ccflare/logger";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getComboSlotInfo,
	isModelCooldownFallback,
	selectAccountsForRequest,
} from "../account-selector";
import {
	clearFamilyExhaustionCache,
	markFamilyExhausted,
} from "../model-capacity";
import {
	markModelCooling,
	markWindowlessModelCooling,
	resetModelCooldownsForTests,
} from "../model-cooldown";
import type { ProxyContext } from "../proxy-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FROZEN_NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MINUTE = 60 * 1000;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: FROZEN_NOW + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: FROZEN_NOW,
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
		timestamp: FROZEN_NOW,
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
		created_at: FROZEN_NOW,
		updated_at: FROZEN_NOW,
		slots,
	};
}

function makeCtx(opts: {
	accounts: Account[];
	activeCombo: ComboWithSlots | null;
	capacityRouting?: "off" | "exhausted";
	comboSessionFallback?: boolean;
	usageThrottling?: boolean;
}): ProxyContext {
	return {
		strategy: {
			select: mock((all: Account[], _meta: RequestMeta) => all),
		},
		dbOps: {
			getAllAccounts: mock(async () => opts.accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: {
			getModelScopedCapacityRouting: () => opts.capacityRouting ?? "off",
			getComboSessionFallback: () => opts.comboSessionFallback ?? true,
			getUsageThrottlingFiveHourEnabled: () => opts.usageThrottling ?? false,
			getUsageThrottlingWeeklyEnabled: () => opts.usageThrottling ?? false,
		},
	} as unknown as ProxyContext;
}

function makeSlot(
	accountId: string,
	model: string,
	priority: number,
): ComboWithSlots["slots"][number] {
	return {
		id: `slot-${accountId}-${model || "passthrough"}`,
		combo_id: "combo-1",
		account_id: accountId,
		model,
		priority,
		enabled: true,
	};
}

beforeEach(() => {
	resetModelCooldownsForTests();
	usageCache.clear();
	clearFamilyExhaustionCache();
	setSystemTime(FROZEN_NOW);
});

afterEach(() => {
	resetModelCooldownsForTests();
	usageCache.clear();
	clearFamilyExhaustionCache();
	setSystemTime();
});

// ── per-(account, model) scoping ──────────────────────────────────────────────

describe("selectAccountsForRequest — combo model-scoped cooldown", () => {
	it("tries windowless-cooled slots soonest first when no healthy combo slot remains", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({
				id: "acc-2",
				model_mappings: JSON.stringify({
					"claude-haiku-latest": "upstream-haiku",
				}),
			}),
			makeAccount({ id: "acc-3" }),
		];
		const combo = makeCombo([
			makeSlot("acc-1", "claude-haiku-5-5", 0),
			makeSlot("acc-2", "claude-haiku-latest", 1),
			makeSlot("acc-3", "claude-haiku-5-5", 2),
		]);
		markWindowlessModelCooling(
			"acc-1",
			"claude-haiku-5-5",
			FROZEN_NOW + 10_000,
		);
		markWindowlessModelCooling("acc-2", "upstream-haiku", FROZEN_NOW);
		markModelCooling("acc-3", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts, activeCombo: combo, comboSessionFallback: false }),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-2", "acc-1"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: "acc-2", modelOverride: "claude-haiku-latest" },
			{ accountId: "acc-1", modelOverride: "claude-haiku-5-5" },
		]);
		expect(isModelCooldownFallback(meta, "acc-2", "upstream-haiku")).toBe(true);
		expect(isModelCooldownFallback(meta, "acc-3", "claude-haiku-5-5")).toBe(
			false,
		);
	});

	it("keeps explicit combo cooldowns skipped when session fallback is disabled", async () => {
		const account = makeAccount();
		markModelCooling(account.id, "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({
				accounts: [account],
				activeCombo: makeCombo([makeSlot(account.id, "claude-haiku-5-5", 0)]),
				comboSessionFallback: false,
			}),
			"claude-haiku-5-5",
		);
		expect(result).toEqual([]);
	});

	it("tries a windowless-cooled combo slot when its healthy sibling is usage-throttled", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markWindowlessModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW);
		usageCache.set("acc-2", {
			five_hour: {
				utilization: 80,
				resets_at: new Date(FROZEN_NOW + 4 * 60 * MINUTE).toISOString(),
			},
		} as never);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx({
				accounts,
				activeCombo: makeCombo(
					accounts.map((account, index) =>
						makeSlot(account.id, "claude-haiku-5-5", index),
					),
				),
				usageThrottling: true,
			}),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-1"]);
		expect(isModelCooldownFallback(meta, "acc-1", "claude-haiku-5-5")).toBe(
			true,
		);
	});

	it("skips scoped usage caps for combo selection to match proxy throttling", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markWindowlessModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW);
		usageCache.set("acc-2", {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 80,
					resets_at: new Date(FROZEN_NOW + 6 * 24 * 60 * MINUTE).toISOString(),
					scope: { model: { display_name: "Haiku" } },
				},
			],
		} as never);
		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({
				accounts,
				activeCombo: makeCombo(
					accounts.map((account, index) =>
						makeSlot(account.id, "claude-haiku-5-5", index),
					),
				),
				usageThrottling: true,
			}),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
	});

	it("handles windowless cooldowns landing after combo selection without bypassing explicit cooldowns", async () => {
		const account = makeAccount();
		const meta = makeRequestMeta();
		await selectAccountsForRequest(
			meta,
			makeCtx({
				accounts: [account],
				activeCombo: makeCombo([makeSlot(account.id, "claude-haiku-5-5", 0)]),
			}),
			"claude-haiku-5-5",
		);
		markWindowlessModelCooling(account.id, "claude-haiku-5-5", FROZEN_NOW);
		expect(isModelCooldownFallback(meta, account.id, "claude-haiku-5-5")).toBe(
			true,
		);
		markModelCooling(account.id, "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		expect(isModelCooldownFallback(meta, account.id, "claude-haiku-5-5")).toBe(
			false,
		);
	});

	it("allows the last windowless combo pair when another candidate receives an explicit cooldown after selection", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		const meta = makeRequestMeta();
		await selectAccountsForRequest(
			meta,
			makeCtx({
				accounts,
				activeCombo: makeCombo(
					accounts.map((account, index) =>
						makeSlot(account.id, "claude-haiku-5-5", index),
					),
				),
			}),
			"claude-haiku-5-5",
		);
		markWindowlessModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW);
		markModelCooling("acc-2", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		expect(isModelCooldownFallback(meta, "acc-1", "claude-haiku-5-5")).toBe(
			true,
		);
		expect(isModelCooldownFallback(meta, "acc-2", "claude-haiku-5-5")).toBe(
			false,
		);
		expect(isModelCooldownFallback(meta)).toBe(true);
	});

	it("checks a combo slot's mapped upstream model and preserves its healthy sibling", async () => {
		const acc = makeAccount({
			id: "acc-1",
			model_mappings: JSON.stringify({
				"claude-haiku-latest": "claude-haiku-5-5",
			}),
		});
		const combo = makeCombo([
			makeSlot("acc-1", "claude-haiku-latest", 0),
			makeSlot("acc-1", "claude-opus-5-5", 1),
		]);
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		expect(
			(await selectAccountsForRequest(meta, ctx, "claude-haiku-latest")).map(
				(account) => account.id,
			),
		).toEqual(["acc-1"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: "acc-1", modelOverride: "claude-opus-5-5" },
		]);
	});

	it("excludes a cooling (account, model) slot but keeps another model's slot on the SAME account", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			makeSlot("acc-1", "claude-sonnet-4-5", 0),
			makeSlot("acc-1", "claude-opus-4-5", 1),
		]);
		markModelCooling("acc-1", "claude-sonnet-4-5", FROZEN_NOW + 10 * MINUTE);
		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// The account itself stays eligible — only the cooled slot is dropped.
		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: "acc-1", modelOverride: "claude-opus-4-5" },
		]);
	});

	it("keeps the combo DEFINITION in definitionSlots even when a slot is cooling", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			makeSlot("acc-1", "claude-sonnet-4-5", 0),
			makeSlot("acc-1", "claude-opus-4-5", 1),
		]);
		markModelCooling("acc-1", "claude-sonnet-4-5", FROZEN_NOW + 10 * MINUTE);
		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		const info = getComboSlotInfo(meta);
		// The routable subset excludes the cooling slot...
		expect(info?.slots).toEqual([
			{ accountId: "acc-1", modelOverride: "claude-opus-4-5" },
		]);
		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
		// ...but the stable definition still lists it, so a 429 on the cooling
		// model's slot can prove the sibling exists (comboHasSiblingModel).
		expect(info?.definitionSlots).toEqual([
			{ accountId: "acc-1", modelOverride: "claude-sonnet-4-5" },
			{ accountId: "acc-1", modelOverride: "claude-opus-4-5" },
		]);
	});

	it("does not affect a different account serving the same model", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			makeSlot("acc-1", "claude-sonnet-4-5", 0),
			makeSlot("acc-2", "claude-sonnet-4-5", 1),
		]);
		markModelCooling("acc-1", "claude-sonnet-4-5", FROZEN_NOW + 10 * MINUTE);
		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// The key is (account, model): acc-2's identical model is unaffected.
		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: "acc-2", modelOverride: "claude-sonnet-4-5" },
		]);
	});

	it("logs the cooldown deadline as an ISO timestamp for the skipped slot", async () => {
		const acc = makeAccount({ id: "acc-1", name: "mistral-vibe" });
		const combo = makeCombo([makeSlot("acc-1", "claude-sonnet-4-5", 0)]);
		const until = FROZEN_NOW + 10 * MINUTE;
		markModelCooling("acc-1", "claude-sonnet-4-5", until);
		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });

		// Console logging is silent outside debug mode, so observe the logger
		// API itself (same approach as proxy-operations-failover.test.ts).
		const infos: string[] = [];
		const infoSpy = spyOn(Logger.prototype, "info").mockImplementation(((
			message: string,
		) => {
			infos.push(message);
		}) as never);
		try {
			await selectAccountsForRequest(
				makeRequestMeta(),
				ctx,
				"claude-sonnet-4-5",
			);
		} finally {
			infoSpy.mockRestore();
		}

		const iso = new Date(until).toISOString();
		expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(infos).toContain(
			`Combo slot mistral-vibe/claude-sonnet-4-5 for Test Combo is in a model-scoped cooldown until ${iso} — skipping (account stays eligible for its other slots)`,
		);
	});

	it("does not exclude a slot whose model has no cooldown entry", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([makeSlot("acc-1", "claude-sonnet-4-5", 0)]);
		// Cooling for a DIFFERENT model must not spill over.
		markModelCooling("acc-1", "claude-opus-4-5", FROZEN_NOW + 10 * MINUTE);
		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
	});
});

describe("selectAccountsForRequest — ordinary pool model cooldown", () => {
	it("tries a cooled account when every uncooled account is locally usage-throttled", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		usageCache.set("acc-2", {
			five_hour: {
				utilization: 80,
				resets_at: new Date(FROZEN_NOW + 4 * 60 * MINUTE).toISOString(),
			},
		} as never);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts, activeCombo: null, usageThrottling: true }),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-1"]);
		expect(isModelCooldownFallback(meta, "acc-1", "claude-haiku-5-5")).toBe(
			true,
		);
	});

	it("preserves every throttled account for the downstream usage-throttling diagnosis", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		for (const account of accounts)
			usageCache.set(account.id, {
				five_hour: {
					utilization: 80,
					resets_at: new Date(FROZEN_NOW + 4 * 60 * MINUTE).toISOString(),
				},
			} as never);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts, activeCombo: null, usageThrottling: true }),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-1", "acc-2"]);
		expect(isModelCooldownFallback(meta)).toBe(false);
	});

	it("tries every cooled account in earliest-expiry order when no healthy model pair remains", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({
				id: "acc-2",
				model_mappings: JSON.stringify({
					"claude-haiku-latest": "upstream-haiku",
				}),
			}),
			makeAccount({ id: "acc-3" }),
		];
		markModelCooling("acc-1", "claude-haiku-latest", FROZEN_NOW + 3 * MINUTE);
		markModelCooling("acc-2", "upstream-haiku", FROZEN_NOW + MINUTE);
		markModelCooling("acc-3", "claude-haiku-latest", FROZEN_NOW + 2 * MINUTE);
		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({ accounts, activeCombo: null }),
			"claude-haiku-latest",
		);
		expect(result.map((account) => account.id)).toEqual([
			"acc-2",
			"acc-3",
			"acc-1",
		]);
	});

	it("keeps a single cooled account routable", async () => {
		const account = makeAccount();
		markModelCooling(account.id, "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account], activeCombo: null }),
			"claude-haiku-5-5",
		);
		expect(result.map((candidate) => candidate.id)).toEqual([account.id]);
		expect(isModelCooldownFallback(meta)).toBe(true);
	});

	it("applies model-cooldown preference after capacity safety filters", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		markFamilyExhausted("acc-2", "haiku", FROZEN_NOW + 10 * MINUTE);
		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({ accounts, activeCombo: null, capacityRouting: "exhausted" }),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-1"]);
	});

	it("allows a last-resort try when every candidate cools after selection", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		const meta = makeRequestMeta();
		await selectAccountsForRequest(
			meta,
			makeCtx({ accounts, activeCombo: null }),
			"claude-haiku-5-5",
		);
		expect(isModelCooldownFallback(meta)).toBe(false);
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		expect(isModelCooldownFallback(meta)).toBe(false);
		markModelCooling("acc-2", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		expect(isModelCooldownFallback(meta)).toBe(true);
		expect(isModelCooldownFallback(meta, "acc-1", "claude-haiku-5-5")).toBe(
			true,
		);
		expect(isModelCooldownFallback(meta, "acc-1", "claude-opus-5-5")).toBe(
			false,
		);
		expect(isModelCooldownFallback(meta, "acc-other", "claude-haiku-5-5")).toBe(
			false,
		);
	});

	it("permits a pinned account's cooled model without substituting another account", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-1" }),
		});
		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts, activeCombo: null }),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-1"]);
		expect(isModelCooldownFallback(meta, "acc-1", "claude-haiku-5-5")).toBe(
			true,
		);
	});

	it("checks only returned attempts when an omitted account recovers before fetch", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + 1000);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts, activeCombo: null }),
			"claude-haiku-5-5",
		);
		expect(result.map((account) => account.id)).toEqual(["acc-2"]);
		setSystemTime(FROZEN_NOW + 1000);
		markWindowlessModelCooling("acc-2", "claude-haiku-5-5");
		expect(isModelCooldownFallback(meta, "acc-2", "claude-haiku-5-5")).toBe(
			true,
		);
	});

	it("keeps trying retained fallback accounts after an earlier cooldown expires", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + 1000);
		markModelCooling("acc-2", "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		const meta = makeRequestMeta();
		await selectAccountsForRequest(
			meta,
			makeCtx({ accounts, activeCombo: null }),
			"claude-haiku-5-5",
		);
		setSystemTime(FROZEN_NOW + 1000);
		expect(isModelCooldownFallback(meta, "acc-2", "claude-haiku-5-5")).toBe(
			true,
		);
	});

	it("skips A for cooled Haiku while keeping A first for healthy Opus", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		const ctx = makeCtx({ accounts, activeCombo: null });
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);

		const haiku = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-haiku-5-5",
		);
		expect(haiku.map((account) => account.id)).toEqual(["acc-2"]);

		const opus = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-5-5",
		);
		expect(opus.map((account) => account.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("checks the mapped upstream model for an ordinary request alias", async () => {
		const accounts = [
			makeAccount({
				id: "acc-1",
				model_mappings: JSON.stringify({
					"claude-haiku-latest": "claude-haiku-5-5",
				}),
			}),
			makeAccount({ id: "acc-2" }),
		];
		const ctx = makeCtx({ accounts, activeCombo: null });
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);

		const haiku = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-haiku-latest",
		);
		expect(haiku.map((account) => account.id)).toEqual(["acc-2"]);

		const opus = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-5-5",
		);
		expect(opus.map((account) => account.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("does not confuse a request alias with a cooled upstream id when mapping to another model", async () => {
		const account = makeAccount({
			id: "acc-1",
			model_mappings: JSON.stringify({ haiku: "claude-opus-5-5" }),
		});
		markModelCooling(account.id, "claude-haiku-5-5", FROZEN_NOW + MINUTE);
		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			makeCtx({ accounts: [account], activeCombo: null }),
			"claude-haiku-5-5",
		);
		expect(result.map((candidate) => candidate.id)).toEqual([account.id]);
	});

	it("returns A to ordinary Haiku selection when its pair cooldown expires", async () => {
		const accounts = [
			makeAccount({ id: "acc-1" }),
			makeAccount({ id: "acc-2" }),
		];
		const ctx = makeCtx({ accounts, activeCombo: null });
		markModelCooling("acc-1", "claude-haiku-5-5", FROZEN_NOW + MINUTE);

		expect(
			(
				await selectAccountsForRequest(
					makeRequestMeta(),
					ctx,
					"claude-haiku-5-5",
				)
			).map((account) => account.id),
		).toEqual(["acc-2"]);

		setSystemTime(FROZEN_NOW + MINUTE);
		expect(
			(
				await selectAccountsForRequest(
					makeRequestMeta(),
					ctx,
					"claude-haiku-5-5",
				)
			).map((account) => account.id),
		).toEqual(["acc-1", "acc-2"]);
	});
});

// ── passthrough slots (empty slot.model) ─────────────────────────────────────

describe("selectAccountsForRequest — passthrough slot model cooldown", () => {
	it("keys a passthrough slot on the REQUEST model: cooling that model excludes it", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			makeSlot("acc-1", "", 0), // passthrough
			makeSlot("acc-2", "claude-sonnet-4-5", 1),
		]);
		// A passthrough slot sends the request's own model upstream, so that is
		// the (account, model) pair that must be cooling.
		markModelCooling("acc-1", "claude-sonnet-4-5", FROZEN_NOW + 10 * MINUTE);
		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// Only the cooling passthrough slot is dropped; acc-2's slot survives.
		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: "acc-2", modelOverride: "claude-sonnet-4-5" },
		]);
	});

	it("keeps a passthrough slot when a DIFFERENT model is cooling", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([makeSlot("acc-1", "", 0)]);
		markModelCooling("acc-1", "claude-opus-4-5", FROZEN_NOW + 10 * MINUTE);
		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: "acc-1", modelOverride: "" },
		]);
	});

	it("treats a whitespace-only slot model as passthrough", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			makeSlot("acc-1", "   ", 0), // whitespace passthrough
			makeSlot("acc-2", "claude-sonnet-4-5", 1),
		]);
		markModelCooling("acc-1", "claude-sonnet-4-5", FROZEN_NOW + 10 * MINUTE);
		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
	});
});

// ── expiry ────────────────────────────────────────────────────────────────────

describe("selectAccountsForRequest — model cooldown expiry", () => {
	it("makes the slot selectable again once the cooldown expires", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			makeSlot("acc-1", "claude-sonnet-4-5", 0),
			makeSlot("acc-2", "claude-sonnet-4-5", 1),
		]);
		const until = FROZEN_NOW + MINUTE;
		markModelCooling("acc-1", "claude-sonnet-4-5", until, FROZEN_NOW);
		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });

		const whileCooling = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-sonnet-4-5",
		);
		expect(whileCooling.map((a) => a.id)).toEqual(["acc-2"]);

		setSystemTime(until);

		const afterExpiry = await selectAccountsForRequest(
			makeRequestMeta({ id: "req-2" }),
			ctx,
			"claude-sonnet-4-5",
		);
		// acc-1's slot is back in rotation (slots are priority-ordered).
		expect(afterExpiry.map((a) => a.id)).toEqual(["acc-1", "acc-2"]);
	});
});
