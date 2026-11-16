/**
 * Combo slots honour TokenHarbor's model-aware peak pricing.
 *
 * The pool path drops peak-affected accounts in `finishSelection`, but the
 * combo branch returns before ever reaching it. A combo that pins a
 * peak-priced model to a TokenHarbor slot would therefore be chosen during
 * peak even when a flat-priced slot is available.
 *
 * The combo branch cannot drop slots — proxy.ts resolves each slot's model pin
 * from `slots` BY POSITION against the returned accounts — so the fix is a
 * stable reorder of the three parallel arrays in lockstep: peak-affected slots
 * sort after the rest, and only when at least one non-peak slot exists.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	clearTokenHarborPeakCacheForTests,
	getTokenHarborPeakListing,
} from "../../tokenharbor-peak";
import {
	getComboSlotInfo,
	selectAccountsForRequest,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// Reference calendar (2026-09, UTC): 23 Wed, 02:00 is inside the
// "14:00–00:00 UTC" off-peak window's complement, i.e. peak.
const WED_PEAK_MS = Date.UTC(2026, 8, 23, 2, 0);

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

function makeTokenHarborAccount(id: string): Account {
	return makeAccount({
		id,
		name: id,
		provider: "anthropic-compatible",
		custom_endpoint: "https://tokenharbor.ai",
		api_key: "test-key",
		peak_hours_pause_enabled: true,
	});
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: WED_PEAK_MS,
		headers: new Headers(),
	};
}

/** A combo whose slots are the given [accountId, model] pairs, in order. */
function makeCombo(slots: Array<[string, string]>): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Peak Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots: slots.map(([accountId, model], i) => ({
			id: `slot-${i}`,
			combo_id: "combo-1",
			account_id: accountId,
			model,
			priority: i,
			enabled: true,
		})),
	};
}

function makeCtx(accounts: Account[], combo: ComboWithSlots): ProxyContext {
	return {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: { getCombosEnabled: () => true },
	} as unknown as ProxyContext;
}

/**
 * Seed the module's listing cache for `account` with `peakModels` priced at
 * "14:00–00:00 UTC". Goes through the public fetch path with a stubbed fetch,
 * so no network is touched.
 */
async function seedListing(
	account: Account,
	peakModels: string[],
	originalFetch: typeof globalThis.fetch,
): Promise<void> {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				data: peakModels.map((id) => ({
					id,
					pricing: { off_peak: { window: "14:00–00:00 UTC" } },
				})),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as unknown as typeof globalThis.fetch;
	try {
		await getTokenHarborPeakListing(account);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe("selectAccountsForRequest — combos honour TokenHarbor peak pricing", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		// The decision reads Date.now() at selection time; pin it inside the
		// model's peak window (02:00 UTC is outside 14:00–00:00).
		setSystemTime(new Date(WED_PEAK_MS));
		clearTokenHarborPeakCacheForTests();
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		setSystemTime();
		globalThis.fetch = originalFetch;
		clearTokenHarborPeakCacheForTests();
	});

	it("puts a flat-priced slot ahead of a peak-affected one, keeping slots index-aligned", async () => {
		const peak = makeTokenHarborAccount("th-peak");
		const flat = makeTokenHarborAccount("th-flat");
		await seedListing(peak, ["deepseek-v4-pro"], originalFetch);
		await seedListing(flat, ["deepseek-v4-pro"], originalFetch);

		// The peak-priced slot is first by priority.
		const combo = makeCombo([
			["th-peak", "deepseek-v4-pro"],
			["th-flat", "claude-opus-5.5"],
		]);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx([peak, flat], combo),
			"claude-opus-5-5",
		);

		expect(result.map((a) => a.id)).toEqual(["th-flat", "th-peak"]);
		const slots = getComboSlotInfo(meta)?.slots ?? [];
		// Same length, and each slot still describes the account at its index —
		// proxy.ts pairs them by position.
		expect(slots).toHaveLength(result.length);
		slots.forEach((slot, i) => {
			expect(slot.accountId).toBe(result[i]?.id);
		});
		expect(slots.map((s) => s.modelOverride)).toEqual([
			"claude-opus-5.5",
			"deepseek-v4-pro",
		]);
	});

	it("leaves the order untouched when every slot is peak-affected", async () => {
		const a = makeTokenHarborAccount("th-a");
		const b = makeTokenHarborAccount("th-b");
		await seedListing(a, ["deepseek-v4-pro"], originalFetch);
		await seedListing(b, ["deepseek-v4-pro"], originalFetch);

		const combo = makeCombo([
			["th-a", "deepseek-v4-pro"],
			["th-b", "deepseek-v4-pro"],
		]);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx([a, b], combo),
			"claude-opus-5-5",
		);

		// Fail open: both are still returned, in their original order.
		expect(result.map((acc) => acc.id)).toEqual(["th-a", "th-b"]);
		expect(getComboSlotInfo(meta)?.slots.map((s) => s.accountId)).toEqual([
			"th-a",
			"th-b",
		]);
	});

	it("uses the request model for a passthrough slot (empty pin)", async () => {
		const th = makeTokenHarborAccount("th-passthrough");
		const flat = makeTokenHarborAccount("th-flat");
		// A Claude-family request model, so the combo lookup runs, that this
		// account's listing marks peak-priced.
		const requestModel = "claude-opus-5-5";
		await seedListing(th, [requestModel], originalFetch);
		await seedListing(flat, [requestModel], originalFetch);

		// The first slot has no pin, so it sends the request's own model — which
		// is peak-priced on this account.
		const combo = makeCombo([
			["th-passthrough", ""],
			["th-flat", "claude-opus-5.5"],
		]);
		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			makeCtx([th, flat], combo),
			requestModel,
		);

		expect(result.map((a) => a.id)).toEqual(["th-flat", "th-passthrough"]);
		expect(getComboSlotInfo(meta)?.slots.map((s) => s.accountId)).toEqual([
			"th-flat",
			"th-passthrough",
		]);
	});
});
