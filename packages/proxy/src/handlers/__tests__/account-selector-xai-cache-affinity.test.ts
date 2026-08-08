import { afterEach, describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	getXaiConvId,
	resetXaiCacheAffinityForTests,
	selectAccountsForRequest,
	setXaiConvId,
	XAI_AFFINITY_MAX_ENTRIES,
	XAI_AFFINITY_TTL_MS,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Deliberately duplicated (not imported) from account-selector.test.ts /
// account-selector-model-capacity.test.ts, matching this directory's existing
// convention of a self-contained fixture set per concern-scoped test file.

afterEach(() => {
	resetXaiCacheAffinityForTests();
});

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "xai",
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
	} as unknown as ProxyContext;
}

// ── setXaiConvId / getXaiConvId ────────────────────────────────────────────

describe("setXaiConvId / getXaiConvId", () => {
	it("stores and retrieves a conv id on a RequestMeta", () => {
		const meta = makeRequestMeta();
		setXaiConvId(meta, "ccflare-xai-abc123");
		expect(getXaiConvId(meta)).toBe("ccflare-xai-abc123");
	});

	it("returns null for a meta that was never set", () => {
		const meta = makeRequestMeta();
		expect(getXaiConvId(meta)).toBeNull();
	});

	it("is isolated per RequestMeta object (WeakMap semantics)", () => {
		const meta1 = makeRequestMeta();
		const meta2 = makeRequestMeta();
		setXaiConvId(meta1, "ccflare-xai-meta1");
		expect(getXaiConvId(meta2)).toBeNull();
	});
});

// ── selectAccountsForRequest — xAI cache-native affinity ───────────────────

describe("selectAccountsForRequest — xAI cache-native affinity", () => {
	it("does not reorder when no conv id is set on the request (flag-off path)", async () => {
		// deriveXaiConvId (packages/providers) returns null whenever
		// CCFLARE_XAI_CACHE_NATIVE is not exactly "1" (see cache-native.test.ts),
		// and proxy.ts only ever calls setXaiConvId with that non-null result —
		// so "no conv id set" IS the flag-off path as observed from
		// account-selector.ts. This test guards the consuming side: absent a
		// conv id, selection must be byte-for-byte the pre-existing order.
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const ctx = makeCtx({ accounts: [xaiA, xaiB] });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result.map((a) => a.id)).toEqual(["xai-a", "xai-b"]);
	});

	it("records ownership on first use without reordering (nothing to prefer yet)", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const ctx = makeCtx({ accounts: [xaiA, xaiB] });
		const meta = makeRequestMeta();
		setXaiConvId(meta, "conv-first-use");

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result.map((a) => a.id)).toEqual(["xai-a", "xai-b"]);
	});

	it("prefers the owning account when it is present and routable on a later request", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });

		// First request establishes ownership on whichever account the strategy
		// puts first — xai-a.
		const ctx1 = makeCtx({ accounts: [xaiA, xaiB] });
		const meta1 = makeRequestMeta();
		setXaiConvId(meta1, "conv-owner-preferred");
		await selectAccountsForRequest(meta1, ctx1);

		// Second request: strategy now ranks xai-b first, but the sticky owner
		// (xai-a) must still be promoted to the front.
		const ctx2 = makeCtx({ accounts: [xaiB, xaiA] });
		const meta2 = makeRequestMeta();
		setXaiConvId(meta2, "conv-owner-preferred");
		const result = await selectAccountsForRequest(meta2, ctx2);

		expect(result.map((a) => a.id)).toEqual(["xai-a", "xai-b"]);
	});

	it("falls back to normal order and transfers ownership when the owner is absent from the candidate list", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });

		// Establish ownership on xai-a.
		const ctx1 = makeCtx({ accounts: [xaiA, xaiB] });
		const meta1 = makeRequestMeta();
		setXaiConvId(meta1, "conv-transfer");
		await selectAccountsForRequest(meta1, ctx1);

		// xai-a is no longer routable/present (e.g. paused/rate-limited and
		// filtered out upstream) — only xai-b is a candidate.
		const ctx2 = makeCtx({ accounts: [xaiB] });
		const meta2 = makeRequestMeta();
		setXaiConvId(meta2, "conv-transfer");
		const result2 = await selectAccountsForRequest(meta2, ctx2);
		expect(result2.map((a) => a.id)).toEqual(["xai-b"]);

		// Ownership must have transferred to xai-b: a third request where both
		// are candidates again, with xai-a ranked first by the strategy, must
		// still promote xai-b (the new owner), not fall back to stale xai-a
		// ownership.
		const ctx3 = makeCtx({ accounts: [xaiA, xaiB] });
		const meta3 = makeRequestMeta();
		setXaiConvId(meta3, "conv-transfer");
		const result3 = await selectAccountsForRequest(meta3, ctx3);
		expect(result3.map((a) => a.id)).toEqual(["xai-b", "xai-a"]);
	});

	it("treats an owner past the TTL window as absent", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const realDateNow = Date.now;
		const baseNow = realDateNow();

		try {
			Date.now = () => baseNow;
			const ctx1 = makeCtx({ accounts: [xaiA, xaiB] });
			const meta1 = makeRequestMeta({ timestamp: baseNow });
			setXaiConvId(meta1, "conv-ttl");
			await selectAccountsForRequest(meta1, ctx1);

			// Advance past the TTL window.
			Date.now = () => baseNow + XAI_AFFINITY_TTL_MS + 1;
			const ctx2 = makeCtx({ accounts: [xaiB, xaiA] });
			const meta2 = makeRequestMeta({
				timestamp: baseNow + XAI_AFFINITY_TTL_MS + 1,
			});
			setXaiConvId(meta2, "conv-ttl");
			const result = await selectAccountsForRequest(meta2, ctx2);

			// Expired ownership: no promotion, strategy order (xai-b, xai-a) wins.
			expect(result.map((a) => a.id)).toEqual(["xai-b", "xai-a"]);
		} finally {
			Date.now = realDateNow;
		}
	});

	it("evicts the oldest entry once the cap is exceeded", async () => {
		const evictedConvId = "conv-cap-0";
		const ctxSeed = makeCtx({ accounts: [makeAccount({ id: "acc-cap" })] });
		const metaSeed = makeRequestMeta();
		setXaiConvId(metaSeed, evictedConvId);
		await selectAccountsForRequest(metaSeed, ctxSeed);

		// Push the table past its cap with distinct conv ids so the very first
		// entry (evictedConvId) becomes the oldest and gets evicted.
		for (let i = 1; i <= XAI_AFFINITY_MAX_ENTRIES; i++) {
			const ctx = makeCtx({ accounts: [makeAccount({ id: `acc-cap-${i}` })] });
			const meta = makeRequestMeta();
			setXaiConvId(meta, `conv-cap-${i}`);
			await selectAccountsForRequest(meta, ctx);
		}

		// The evicted conv id's former owner ("acc-cap") must no longer be
		// promoted — selection falls back to the strategy's own order.
		const accX = makeAccount({ id: "acc-new-first" });
		const accY = makeAccount({ id: "acc-cap" });
		const ctxCheck = makeCtx({ accounts: [accX, accY] });
		const metaCheck = makeRequestMeta();
		setXaiConvId(metaCheck, evictedConvId);
		const result = await selectAccountsForRequest(metaCheck, ctxCheck);

		expect(result.map((a) => a.id)).toEqual(["acc-new-first", "acc-cap"]);
	});

	it("scopes ownership per conv id — different conversations do not interfere", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });

		const ctx1 = makeCtx({ accounts: [xaiA, xaiB] });
		const meta1 = makeRequestMeta();
		setXaiConvId(meta1, "conv-scope-1");
		await selectAccountsForRequest(meta1, ctx1);

		const ctx2 = makeCtx({ accounts: [xaiB, xaiA] });
		const meta2 = makeRequestMeta();
		setXaiConvId(meta2, "conv-scope-2");
		await selectAccountsForRequest(meta2, ctx2);

		// conv-scope-1's owner (xai-a) must still be promoted for its own
		// conversation, independent of conv-scope-2's owner (xai-b).
		const ctx3 = makeCtx({ accounts: [xaiB, xaiA] });
		const meta3 = makeRequestMeta();
		setXaiConvId(meta3, "conv-scope-1");
		const result = await selectAccountsForRequest(meta3, ctx3);
		expect(result.map((a) => a.id)).toEqual(["xai-a", "xai-b"]);
	});

	it("never promotes the owner ahead of a non-xai account the strategy preferred (mixed pool)", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const anthropicAcc = makeAccount({
			id: "anthropic-1",
			provider: "anthropic",
		});

		// Seed ownership of xai-b (it leads an all-xai pool).
		const ctxSeed = makeCtx({ accounts: [xaiB, xaiA] });
		const metaSeed = makeRequestMeta();
		setXaiConvId(metaSeed, "conv-mixed-pool");
		await selectAccountsForRequest(metaSeed, ctxSeed);

		// Mixed pool with a non-xai account the strategy put first: affinity
		// must only reorder WITHIN the xai subset — anthropic-1 keeps the
		// lead, xai-b (owner) moves ahead of xai-a only.
		const ctx = makeCtx({ accounts: [anthropicAcc, xaiA, xaiB] });
		const meta = makeRequestMeta();
		setXaiConvId(meta, "conv-mixed-pool");
		const result = await selectAccountsForRequest(meta, ctx);
		expect(result.map((a) => a.id)).toEqual(["anthropic-1", "xai-b", "xai-a"]);
	});

	it("does not transfer ownership while a non-xai account is the presumptive server", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		const anthropicAcc = makeAccount({
			id: "anthropic-1",
			provider: "anthropic",
		});

		// Seed ownership of xai-b.
		const ctxSeed = makeCtx({ accounts: [xaiB, xaiA] });
		const metaSeed = makeRequestMeta();
		setXaiConvId(metaSeed, "conv-no-steal");
		await selectAccountsForRequest(metaSeed, ctxSeed);

		// Non-xai leader: the request won't touch any xai cache partition, so
		// ownership must NOT be reassigned to xai-a merely for being the
		// first xai account in this pool.
		const ctxMixed = makeCtx({ accounts: [anthropicAcc, xaiA, xaiB] });
		const metaMixed = makeRequestMeta();
		setXaiConvId(metaMixed, "conv-no-steal");
		await selectAccountsForRequest(metaMixed, ctxMixed);

		// Back to an all-xai pool: xai-b must still own the conversation.
		const ctxCheck = makeCtx({ accounts: [xaiA, xaiB] });
		const metaCheck = makeRequestMeta();
		setXaiConvId(metaCheck, "conv-no-steal");
		const result = await selectAccountsForRequest(metaCheck, ctxCheck);
		expect(result.map((a) => a.id)).toEqual(["xai-b", "xai-a"]);
	});

	it("ignores non-xai and custom-endpoint xai accounts as affinity owners", async () => {
		const anthropicAcc = makeAccount({
			id: "anthropic-1",
			provider: "anthropic",
		});
		const customXai = makeAccount({
			id: "xai-custom",
			custom_endpoint: "https://my-proxy.example.com/v1",
		});
		const ctx = makeCtx({ accounts: [anthropicAcc, customXai] });
		const meta = makeRequestMeta();
		setXaiConvId(meta, "conv-no-eligible-owner");

		const result = await selectAccountsForRequest(meta, ctx);
		// No eligible (official xai) candidate to record as owner — order must
		// be left completely untouched.
		expect(result.map((a) => a.id)).toEqual(["anthropic-1", "xai-custom"]);
	});

	it("does not affect the forced-account header path even when a conv id and prior ownership exist", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });

		// Establish ownership on xai-a for this conv id.
		const ctx1 = makeCtx({ accounts: [xaiA, xaiB] });
		const meta1 = makeRequestMeta();
		setXaiConvId(meta1, "conv-forced");
		await selectAccountsForRequest(meta1, ctx1);

		// A forced-account request for xai-b must return exactly xai-b,
		// regardless of xai-a's sticky ownership — the forced-account path
		// (x-better-ccflare-account-id) is out of scope for affinity.
		const ctx2 = makeCtx({ accounts: [xaiA, xaiB] });
		const meta2 = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "xai-b" }),
		});
		setXaiConvId(meta2, "conv-forced");
		const result = await selectAccountsForRequest(meta2, ctx2);
		expect(result.map((a) => a.id)).toEqual(["xai-b"]);
	});

	it("does not affect combo-routed selection even when a conv id and prior ownership exist", async () => {
		const xaiA = makeAccount({ id: "xai-a" });
		const xaiB = makeAccount({ id: "xai-b" });
		// Combos are provider-agnostic (a slot is just account_id + model
		// override), so an xai account can sit in a Claude-family combo slot —
		// this is what exercises the combo-routing return point (line ~474)
		// with an xai owner in play.
		const comboAcc = makeAccount({ id: "combo-acc", provider: "xai" });

		// Establish ownership on xai-a for this conv id via normal (non-combo,
		// no model) selection first.
		const ctxSeed = makeCtx({ accounts: [xaiA, xaiB] });
		const metaSeed = makeRequestMeta();
		setXaiConvId(metaSeed, "conv-combo");
		await selectAccountsForRequest(metaSeed, ctxSeed);

		// A combo-routed request (model resolves to a known family + an active
		// combo for it) must return exactly the combo's own slot accounts,
		// unaffected by xai-a's sticky ownership — combo routing returns before
		// either of the two affinity-wrapped return points is ever reached.
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "combo-acc",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [comboAcc, xaiA, xaiB],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();
		setXaiConvId(meta, "conv-combo");
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["combo-acc"]);
	});
});
