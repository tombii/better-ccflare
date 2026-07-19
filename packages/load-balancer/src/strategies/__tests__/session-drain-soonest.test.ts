import { beforeEach, describe, expect, it } from "bun:test";
import { SessionDrainSoonestStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

// ---------------------------------------------------------------------------
// Shared Account factory — mirrors session-strategy.test.ts's makeAccount so
// tests focus on the fields that actually differ.
// ---------------------------------------------------------------------------
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-account",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "test",
		access_token: "test",
		expires_at: Date.now() + 3600_000,
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

// Mock StrategyStore for testing — adds getAccountWeeklyReset on top of the
// session-strategy.test.ts pattern.
class MockStrategyStore implements StrategyStore {
	resetCalls: Array<{ accountId: string; timestamp: number }> = [];
	resumeCalls: string[] = [];
	utilizationMap: Map<string, number | null> = new Map();
	weeklyResetMap: Map<string, number | null> = new Map();

	resetAccountSession(accountId: string, timestamp: number): void {
		this.resetCalls.push({ accountId, timestamp });
	}

	resumeAccount(accountId: string): void {
		this.resumeCalls.push(accountId);
	}

	getAccountUtilization(accountId: string, _provider: string): number | null {
		if (!this.utilizationMap.has(accountId)) return null;
		return this.utilizationMap.get(accountId) ?? null;
	}

	getAccountWeeklyReset(accountId: string, _provider: string): number | null {
		if (!this.weeklyResetMap.has(accountId)) return null;
		return this.weeklyResetMap.get(accountId) ?? null;
	}

	setUtilization(accountId: string, value: number | null): void {
		this.utilizationMap.set(accountId, value);
	}

	setWeeklyReset(accountId: string, value: number | null): void {
		this.weeklyResetMap.set(accountId, value);
	}

	clear(): void {
		this.resetCalls = [];
		this.resumeCalls = [];
		this.utilizationMap.clear();
		this.weeklyResetMap.clear();
	}

	getResetCall(
		accountId: string,
	): { accountId: string; timestamp: number } | undefined {
		return this.resetCalls.find((call) => call.accountId === accountId);
	}

	hasResumeCall(accountId: string): boolean {
		return this.resumeCalls.includes(accountId);
	}
}

describe("SessionDrainSoonestStrategy", () => {
	let strategy: SessionDrainSoonestStrategy;
	let mockStore: MockStrategyStore;
	let meta: RequestMeta;

	beforeEach(() => {
		strategy = new SessionDrainSoonestStrategy(5 * 60 * 60 * 1000); // 5 hour default duration
		mockStore = new MockStrategyStore();
		strategy.initialize(mockStore);

		meta = {
			id: "test-request",
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
			timestamp: Date.now(),
		};
	});

	// -------------------------------------------------------------------------
	// Ranking: earliest future weekly reset wins, unknown reset sorts last,
	// ties fall back to priority then utilization.
	// -------------------------------------------------------------------------
	describe("ranking by weekly reset", () => {
		it("prefers the account with the earliest future weekly reset over static priority", () => {
			const now = Date.now();

			const soonestReset = makeAccount({
				id: "soonest-reset",
				name: "soonest-reset",
				priority: 5, // lower priority (higher number) than the other account
			});
			const laterReset = makeAccount({
				id: "later-reset",
				name: "later-reset",
				priority: 0, // higher priority — should still lose to earlier reset
			});

			mockStore.setWeeklyReset("soonest-reset", now + 60 * 60 * 1000); // 1h
			mockStore.setWeeklyReset("later-reset", now + 5 * 60 * 60 * 1000); // 5h

			const result = strategy.select([laterReset, soonestReset], meta);

			expect(result[0]).toBe(soonestReset);
			expect(result[1]).toBe(laterReset);
		});

		it("sorts accounts with an unknown reset behind every account with a known future reset", () => {
			const now = Date.now();

			const knownReset = makeAccount({
				id: "known-reset",
				name: "known-reset",
				priority: 9,
			});
			const unknownReset = makeAccount({
				id: "unknown-reset",
				name: "unknown-reset",
				priority: 0, // higher priority, but must still sort behind known reset
			});

			mockStore.setWeeklyReset("known-reset", now + 60 * 60 * 1000);
			// unknownReset: no entry in weeklyResetMap → null

			const result = strategy.select([unknownReset, knownReset], meta);

			expect(result[0]).toBe(knownReset);
			expect(result[1]).toBe(unknownReset);
		});

		it("treats an already-passed weekly reset as unknown (sorts last)", () => {
			const now = Date.now();

			const futureReset = makeAccount({
				id: "future-reset",
				name: "future-reset",
				priority: 9,
			});
			const pastReset = makeAccount({
				id: "past-reset",
				name: "past-reset",
				priority: 0,
			});

			mockStore.setWeeklyReset("future-reset", now + 60 * 60 * 1000);
			mockStore.setWeeklyReset("past-reset", now - 1000); // already passed

			const result = strategy.select([pastReset, futureReset], meta);

			expect(result[0]).toBe(futureReset);
			expect(result[1]).toBe(pastReset);
		});

		it("falls back to priority ASC when weekly resets are equal", () => {
			const now = Date.now();
			const sharedReset = now + 60 * 60 * 1000;

			const highPriority = makeAccount({
				id: "high-priority",
				name: "high-priority",
				priority: 0,
			});
			const lowPriority = makeAccount({
				id: "low-priority",
				name: "low-priority",
				priority: 1,
			});

			mockStore.setWeeklyReset("high-priority", sharedReset);
			mockStore.setWeeklyReset("low-priority", sharedReset);

			const result = strategy.select([lowPriority, highPriority], meta);

			expect(result[0]).toBe(highPriority);
			expect(result[1]).toBe(lowPriority);
		});

		it("falls back to utilization ASC when weekly reset and priority are both equal", () => {
			const now = Date.now();
			const sharedReset = now + 60 * 60 * 1000;

			const highUtil = makeAccount({
				id: "high-util",
				name: "high-util",
				priority: 0,
			});
			const lowUtil = makeAccount({
				id: "low-util",
				name: "low-util",
				priority: 0,
			});

			mockStore.setWeeklyReset("high-util", sharedReset);
			mockStore.setWeeklyReset("low-util", sharedReset);
			mockStore.setUtilization("high-util", 80);
			mockStore.setUtilization("low-util", 20);

			const result = strategy.select([highUtil, lowUtil], meta);

			expect(result[0]).toBe(lowUtil);
			expect(result[1]).toBe(highUtil);
		});

		it("treats accounts with no weekly-reset data at all the same as unknown (all tie on priority)", () => {
			const a = makeAccount({ id: "a", name: "a", priority: 1 });
			const b = makeAccount({ id: "b", name: "b", priority: 0 });
			// Neither account has weekly-reset data configured.

			const result = strategy.select([a, b], meta);

			expect(result[0]).toBe(b);
			expect(result[1]).toBe(a);
		});
	});

	// -------------------------------------------------------------------------
	// v3: session stickiness — NO mid-session preemption. Drain-soonest ranking
	// only governs which account is chosen at a fresh/re-selection (session
	// start, session expiry, account unavailable). An active session keeps its
	// account for the rest of the session no matter how much earlier another
	// account's weekly reset is; COHORT_TOLERANCE_MS and the old
	// hasStrictlyEarlierReset preemption branches are gone.
	// -------------------------------------------------------------------------
	describe("session stickiness (no mid-session preemption)", () => {
		it("keeps the active-session account when another account's reset is only slightly earlier", () => {
			const now = Date.now();

			const active = makeAccount({
				id: "active",
				name: "active",
				session_start: now - 30 * 60 * 1000,
				session_request_count: 10,
				priority: 5,
			});
			const sameCohort = makeAccount({
				id: "same-cohort",
				name: "same-cohort",
				priority: 0,
			});

			mockStore.setWeeklyReset("active", now + 60 * 60 * 1000);
			// 30s earlier — previously inside the 60s cohort tolerance.
			mockStore.setWeeklyReset("same-cohort", now + 60 * 60 * 1000 - 30_000);

			const result = strategy.select([sameCohort, active], meta);

			expect(result[0]).toBe(active);
		});

		it("keeps the active-session account even when another account's reset is strictly, substantially earlier", () => {
			const now = Date.now();

			const active = makeAccount({
				id: "active",
				name: "active",
				session_start: now - 30 * 60 * 1000,
				session_request_count: 10,
				priority: 0,
			});
			const soonerReset = makeAccount({
				id: "sooner-reset",
				name: "sooner-reset",
				priority: 5,
			});

			mockStore.setWeeklyReset("active", now + 60 * 60 * 1000);
			// 5 minutes earlier — under v2 this used to preempt; v3 must NOT.
			mockStore.setWeeklyReset(
				"sooner-reset",
				now + 60 * 60 * 1000 - 5 * 60 * 1000,
			);

			const result = strategy.select([active, soonerReset], meta);

			expect(result[0]).toBe(active);
			// Active session's own bookkeeping should be untouched.
			expect(mockStore.getResetCall(active.id)).toBeUndefined();
		});

		it("keeps the active-session account (unknown reset) even when a candidate has a known future reset", () => {
			const now = Date.now();

			const active = makeAccount({
				id: "active",
				name: "active",
				session_start: now - 30 * 60 * 1000,
				session_request_count: 10,
				priority: 0,
			});
			const known = makeAccount({
				id: "known",
				name: "known",
				priority: 5,
			});

			// active has no weekly-reset data → unknown
			mockStore.setWeeklyReset("known", now + 60 * 60 * 1000);

			const result = strategy.select([active, known], meta);

			expect(result[0]).toBe(active);
		});

		it("keeps stickiness when the only other candidate also has an unknown reset", () => {
			const now = Date.now();

			const active = makeAccount({
				id: "active",
				name: "active",
				session_start: now - 30 * 60 * 1000,
				session_request_count: 10,
				priority: 5,
			});
			const otherUnknown = makeAccount({
				id: "other-unknown",
				name: "other-unknown",
				priority: 0,
			});

			// Neither account has weekly-reset data.

			const result = strategy.select([active, otherUnknown], meta);

			expect(result[0]).toBe(active);
		});

		it("selects the earliest-reset account on a fresh (no active session) re-selection after the sticky session ends", () => {
			// S6: "active session on B stays until session end, even though A
			// resets earlier; a NEW selection (no active session) picks A."
			const now = Date.now();

			const accountA = makeAccount({ id: "A", name: "A", priority: 5 });
			const accountB = makeAccount({ id: "B", name: "B", priority: 0 });
			// No session_start set on either — this models the post-session-end
			// re-selection moment (SessionStrategy semantics: no active session).

			mockStore.setWeeklyReset("A", now + 24 * 60 * 60 * 1000); // +1d
			mockStore.setWeeklyReset("B", now + 3 * 24 * 60 * 60 * 1000); // +3d

			const result = strategy.select([accountB, accountA], meta);

			expect(result[0]).toBe(accountA);
		});
	});

	// -------------------------------------------------------------------------
	// Rate-limited session account → failover ordering.
	// -------------------------------------------------------------------------
	describe("failover when the active-session account is rate-limited", () => {
		it("yields to a healthy account when the active-session account is currently rate-limited", () => {
			const now = Date.now();

			const throttled = makeAccount({
				id: "throttled",
				name: "throttled",
				rate_limited_until: now + 30 * 60 * 1000,
				session_start: now - 30 * 60 * 1000,
				session_request_count: 50,
				priority: 0,
			});

			const healthy = makeAccount({
				id: "healthy",
				name: "healthy",
				priority: 5,
			});

			mockStore.setWeeklyReset("throttled", now + 60 * 60 * 1000);
			mockStore.setWeeklyReset("healthy", now + 5 * 60 * 60 * 1000); // later reset, lower priority

			const result = strategy.select([throttled, healthy], meta);

			expect(result[0]).toBe(healthy);
			expect(result.find((a) => a.id === throttled.id)).toBeUndefined();
			// session_start preserved for prompt-cache continuity
			expect(throttled.session_start).toBe(now - 30 * 60 * 1000);
			expect(throttled.session_request_count).toBe(50);
		});

		it("resumes the original active session once the rate-limit window elapses", () => {
			const now = Date.now();

			const recovered = makeAccount({
				id: "recovered",
				name: "recovered",
				rate_limited_until: now - 1000, // elapsed
				session_start: now - 60 * 60 * 1000,
				session_request_count: 25,
			});

			const result = strategy.select([recovered], meta);

			expect(result[0]).toBe(recovered);
			expect(mockStore.getResetCall(recovered.id)).toBeUndefined();
			expect(recovered.session_start).toBe(now - 60 * 60 * 1000);
			expect(recovered.session_request_count).toBe(25);
		});

		it("auto-fallback reactivates a paused account whose provider rate-limit window has reset", () => {
			const now = Date.now();

			const reactivated = makeAccount({
				id: "reactivated",
				name: "reactivated",
				paused: true,
				rate_limit_reset: now - 2000, // expired
				priority: 0,
				auto_fallback_enabled: true,
			});

			const stillPaused = makeAccount({
				id: "still-paused",
				name: "still-paused",
				paused: true,
				rate_limit_reset: now, // not expired
				priority: 1,
				auto_fallback_enabled: true,
			});

			const result = strategy.select([stillPaused, reactivated], meta);

			expect(result[0]).toBe(reactivated);
			expect(reactivated.paused).toBe(false);
			expect(mockStore.hasResumeCall(reactivated.id)).toBe(true);
			expect(stillPaused.paused).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// peek()/select() consistency — the dashboard's "Primary" badge depends on
	// peek() always agreeing with what select() would actually pick.
	// -------------------------------------------------------------------------
	describe("peek/select consistency", () => {
		it("peek agrees with select for drain-soonest ranking (no active session)", () => {
			const now = Date.now();

			const soonest = makeAccount({
				id: "soonest",
				name: "soonest",
				priority: 5,
			});
			const later = makeAccount({ id: "later", name: "later", priority: 0 });

			mockStore.setWeeklyReset("soonest", now + 60 * 60 * 1000);
			mockStore.setWeeklyReset("later", now + 5 * 60 * 60 * 1000);

			const accounts = [later, soonest];
			expect(strategy.peek(accounts)).toBe(
				strategy.select(accounts, meta)[0]?.id,
			);
			expect(strategy.peek(accounts)).toBe("soonest");
		});

		it("peek agrees with select when cohort stickiness keeps the active session", () => {
			const now = Date.now();

			const active = makeAccount({
				id: "active",
				name: "active",
				session_start: now - 30 * 60 * 1000,
				session_request_count: 10,
				priority: 5,
			});
			const sameCohort = makeAccount({
				id: "same-cohort",
				name: "same-cohort",
				priority: 0,
			});

			mockStore.setWeeklyReset("active", now + 60 * 60 * 1000);
			mockStore.setWeeklyReset("same-cohort", now + 60 * 60 * 1000 - 30_000);

			const accounts = [sameCohort, active];
			const peeked = strategy.peek(accounts);
			const selected = strategy.select(accounts, meta)[0]?.id;

			expect(peeked).toBe(selected);
			expect(peeked).toBe("active");
		});

		it("peek agrees with select: active session is never preempted by a substantially-earlier-reset candidate (v3)", () => {
			const now = Date.now();

			const active = makeAccount({
				id: "active",
				name: "active",
				session_start: now - 30 * 60 * 1000,
				session_request_count: 10,
				priority: 0,
			});
			const notPreempting = makeAccount({
				id: "not-preempting",
				name: "not-preempting",
				priority: 5,
			});

			mockStore.setWeeklyReset("active", now + 60 * 60 * 1000);
			mockStore.setWeeklyReset(
				"not-preempting",
				now + 60 * 60 * 1000 - 5 * 60 * 1000,
			);

			const accounts = [active, notPreempting];
			const peeked = strategy.peek(accounts);
			const selected = strategy.select(accounts, meta)[0]?.id;

			expect(peeked).toBe(selected);
			expect(peeked).toBe("active");
		});

		it("peek does not mutate state (side-effect-free)", () => {
			const now = Date.now();

			const paused = makeAccount({
				id: "paused-account",
				name: "paused-account",
				paused: true,
				rate_limit_reset: now - 2000,
				auto_fallback_enabled: true,
			});

			strategy.peek([paused]);

			expect(paused.paused).toBe(true);
			expect(mockStore.hasResumeCall(paused.id)).toBe(false);
			expect(mockStore.resetCalls).toHaveLength(0);
		});

		it("peek returns null when no accounts are available", () => {
			const rateLimited = makeAccount({
				id: "rate-limited",
				name: "rate-limited",
				rate_limited_until: Date.now() + 60_000,
			});

			expect(strategy.peek([rateLimited])).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// v3 Fix5 (Revision v2, codex-9): auto-fallback is a PRIORITY rule — the
	// chosen fallback account is guaranteed at position 0 of select()'s return
	// value (and is what peek() returns), even when drain-soonest ranking by
	// weekly reset would otherwise place a different available account first.
	// -------------------------------------------------------------------------
	describe("auto-fallback position-0 guarantee (S6)", () => {
		it("select() returns the chosen auto-fallback account at position 0 even when another available account has an earlier drain reset", () => {
			const now = Date.now();

			const fallback = makeAccount({
				id: "fallback",
				name: "fallback",
				paused: true,
				rate_limit_reset: now - 2000, // expired -> triggers reactivation
				priority: 0,
				auto_fallback_enabled: true,
			});
			const earlierDrain = makeAccount({
				id: "earlier-drain",
				name: "earlier-drain",
				priority: 5,
			});

			// earlierDrain has a known, earlier weekly reset than fallback (which
			// has none) — drain-soonest ranking ALONE would place it first.
			mockStore.setWeeklyReset("earlier-drain", now + 60 * 1000);

			const result = strategy.select([earlierDrain, fallback], meta);

			expect(result[0]).toBe(fallback);
			expect(result.map((a) => a.id)).toEqual(["fallback", "earlier-drain"]);
		});

		it("peek() returns the chosen auto-fallback account under the same conditions", () => {
			const now = Date.now();

			const fallback = makeAccount({
				id: "fallback",
				name: "fallback",
				paused: true,
				rate_limit_reset: now - 2000,
				priority: 0,
				auto_fallback_enabled: true,
			});
			const earlierDrain = makeAccount({
				id: "earlier-drain",
				name: "earlier-drain",
				priority: 5,
			});

			mockStore.setWeeklyReset("earlier-drain", now + 60 * 1000);

			const accounts = [earlierDrain, fallback];
			expect(strategy.peek(accounts)).toBe("fallback");
			expect(strategy.peek(accounts)).toBe(
				strategy.select(accounts, meta)[0]?.id,
			);
		});

		it("select() places the chosen fallback first even when a second, lower-priority fallback candidate would otherwise win the drain-ranking tiebreak", () => {
			// Two accounts are eligible for auto-fallback reactivation; the one
			// checkForAutoFallbackAccounts picks first (priority ASC among
			// fallback candidates) must end up at position 0 regardless of how
			// the full drain-soonest comparator would have ordered the pool.
			const now = Date.now();

			const chosenFallback = makeAccount({
				id: "chosen",
				name: "chosen",
				paused: true,
				rate_limit_reset: now - 2000,
				priority: 0, // wins among fallback candidates
				auto_fallback_enabled: true,
			});
			const earlierButNotChosen = makeAccount({
				id: "earlier-but-not-chosen",
				name: "earlier-but-not-chosen",
				priority: 9,
			});

			mockStore.setWeeklyReset("earlier-but-not-chosen", now + 30 * 1000);
			// chosenFallback has no weekly-reset data (unknown, sorts last on its own).

			const result = strategy.select(
				[earlierButNotChosen, chosenFallback],
				meta,
			);

			expect(result[0]).toBe(chosenFallback);
		});
	});
});
