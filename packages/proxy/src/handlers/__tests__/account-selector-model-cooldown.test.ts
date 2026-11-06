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
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
} from "../account-selector";
import {
	markModelCooling,
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
}): ProxyContext {
	return {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => opts.accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => opts.accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getModelScopedCapacityRouting: () => "off" },
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
	setSystemTime(FROZEN_NOW);
});

afterEach(() => {
	resetModelCooldownsForTests();
	setSystemTime();
});

// ── per-(account, model) scoping ──────────────────────────────────────────────

describe("selectAccountsForRequest — combo model-scoped cooldown", () => {
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
		const acc = makeAccount({ id: "acc-1" });
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
			`Combo slot acc-1/claude-sonnet-4-5 for Test Combo is in a model-scoped cooldown until ${iso} — skipping (account stays eligible for its other slots)`,
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
