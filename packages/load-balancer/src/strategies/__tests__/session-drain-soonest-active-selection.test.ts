import { beforeEach, describe, expect, it } from "bun:test";
import { SessionDrainSoonestStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

// ---------------------------------------------------------------------------
// Characterization tests for HOLDER SELECTION among MULTIPLE active sessions.
//
// The sibling suite (session-drain-soonest.test.ts) covers stickiness with a
// single active session and drain ranking with none. This file pins the
// behaviour in the production-normal case that suite never exercises: several
// accounts hold an active 5h session AT THE SAME TIME, and the strategy must
// pick ONE of them. Sessions are opened by a served request when none is
// active (updateAccountUsage only writes session_start if it is NULL or older
// than the session duration — account.repository.ts), and created/reset
// independently by the usage-poller rollover callback and by
// keepalive/auto-refresh probes.
//
// Current behaviour (pinned here, GREEN against main): the account with the
// MOST RECENT session_start wins position 0 regardless of its weekly-reset
// rank — the drain comparator only orders the tail. Observed in production
// (2026-08-19/20 trace): 3 570/3 570 events tail-sorted correctly, 0 drain
// decisions at position 0; the earliest-reset account received 12 % of
// traffic while ranked #1 in 100 % of decisions.
//
// These tests document the status quo so a future "strict" ranking option can
// change it deliberately (new tests) instead of silently.
// ---------------------------------------------------------------------------

// Shared Account factory — mirrors session-drain-soonest.test.ts's makeAccount
// so tests focus on the fields that actually differ.
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

// Mock StrategyStore — same shape as the sibling suite's. Indexed by account
// id only (provider is ignored), so every test uses unique ids and sets reset
// and utilization explicitly where the scenario depends on them.
class MockStrategyStore implements StrategyStore {
	utilizationMap: Map<string, number | null> = new Map();
	weeklyResetMap: Map<string, number | null> = new Map();

	resetAccountSession(_accountId: string, _timestamp: number): void {}

	resumeAccount(_accountId: string): void {}

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
}

const meta: RequestMeta = {
	id: "test-request",
	headers: new Headers(),
	path: "/v1/messages",
	method: "POST",
	timestamp: Date.now(),
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("SessionDrainSoonestStrategy — holder selection among multiple active sessions (characterization)", () => {
	let strategy: SessionDrainSoonestStrategy;
	let store: MockStrategyStore;

	beforeEach(() => {
		strategy = new SessionDrainSoonestStrategy();
		store = new MockStrategyStore();
		strategy.initialize(store);
	});

	/**
	 * Two available accounts, both with an active session. The YOUNGER
	 * session wins position 0 even though the older-session account resets
	 * a full five days earlier AND has lower utilization — the drain
	 * comparator does not participate in the holder choice at all.
	 *
	 * Deliberately stacked against the winner: later reset, higher
	 * utilization. Only session_start recency differs in its favour.
	 */
	it("select() picks the youngest active session even when an older active session has a strictly earlier weekly reset", () => {
		const now = Date.now();
		const drainEarly = makeAccount({
			id: "drain-early",
			name: "drain-early",
			session_start: now - 2 * HOUR, // active, but older
		});
		const drainLate = makeAccount({
			id: "drain-late",
			name: "drain-late",
			session_start: now - 30 * 60 * 1000, // active, youngest
		});
		store.setWeeklyReset("drain-early", now + 1 * DAY);
		store.setWeeklyReset("drain-late", now + 6 * DAY);
		store.setUtilization("drain-early", 10);
		store.setUtilization("drain-late", 90);

		// Both input orders, so a stable sort cannot fake the result.
		const resultA = strategy.select([drainEarly, drainLate], meta);
		expect(resultA[0].id).toBe("drain-late");

		const resultB = strategy.select(
			[
				makeAccount({
					id: "drain-late",
					name: "drain-late",
					session_start: now - 30 * 60 * 1000,
				}),
				makeAccount({
					id: "drain-early",
					name: "drain-early",
					session_start: now - 2 * HOUR,
				}),
			],
			meta,
		);
		expect(resultB[0].id).toBe("drain-late");
	});

	/**
	 * The production "coronation" mechanism, shown as a TRANSITION: the
	 * incumbent drain-rank-1 holder wins first; the moment another account
	 * receives a fresh session_start (in production written by the
	 * usage-poller rollover callback, by keepalive/auto-refresh probes, or
	 * by a served request when no session was active — none of which carry
	 * drain intent), that account takes position 0.
	 */
	it("a freshly opened session takes position 0 from a drain-earlier active holder", () => {
		const now = Date.now();
		const incumbent = makeAccount({
			id: "incumbent",
			name: "incumbent",
			session_start: now - 3 * HOUR, // holding, drain rank 1
		});
		const middle = makeAccount({
			id: "middle",
			name: "middle",
			session_start: now - 4 * HOUR,
		});
		const other = makeAccount({
			id: "other",
			name: "other",
			session_start: null, // no session yet
		});
		store.setWeeklyReset("incumbent", now + 1 * DAY);
		store.setWeeklyReset("middle", now + 2 * DAY);
		store.setWeeklyReset("other", now + 6 * DAY);

		// Phase 1: without the fresh write, the incumbent holds position 0.
		const before = strategy.select([incumbent, middle, other], meta);
		expect(before[0].id).toBe("incumbent");

		// Phase 2: a probe/poller-equivalent write opens a session on the
		// drain-LATEST account — it takes the crown immediately.
		other.session_start = now - 60 * 1000;
		const after = strategy.select([incumbent, middle, other], meta);
		expect(after[0].id).toBe("other");
		// The tail IS drain-sorted — the comparator works, it just never
		// decides position 0 (matches the production trace: 3 570/3 570
		// tails correct).
		expect(after.map((a) => a.id)).toEqual(["other", "incumbent", "middle"]);
	});

	/**
	 * Tie on session_start: the active-session scan uses a strict `>`, so
	 * with IDENTICAL timestamps the FIRST account in input order wins —
	 * the current holder choice is input-order-dependent in this edge.
	 * (The strict mode replaces this with a deterministic account-id
	 * anchor.)
	 */
	it("with identical session_start values, input order decides position 0", () => {
		const now = Date.now();
		const sharedStart = now - 1 * HOUR;
		const mk = (id: string) =>
			makeAccount({ id, name: id, session_start: sharedStart });
		store.setWeeklyReset("acc-a", now + 2 * DAY);
		store.setWeeklyReset("acc-z", now + 2 * DAY);

		expect(strategy.select([mk("acc-z"), mk("acc-a")], meta)[0].id).toBe(
			"acc-z",
		);
		expect(strategy.select([mk("acc-a"), mk("acc-z")], meta)[0].id).toBe(
			"acc-a",
		);
	});

	/**
	 * peek() must agree with select() on the youngest-wins rule — the
	 * dashboard's "Primary" badge is computed from peek().
	 */
	it("peek() agrees with select(): youngest active session wins over a drain-earlier active one", () => {
		const now = Date.now();
		const drainEarly = makeAccount({
			id: "drain-early",
			name: "drain-early",
			session_start: now - 2 * HOUR,
		});
		const drainLate = makeAccount({
			id: "drain-late",
			name: "drain-late",
			session_start: now - 30 * 60 * 1000,
		});
		store.setWeeklyReset("drain-early", now + 1 * DAY);
		store.setWeeklyReset("drain-late", now + 6 * DAY);

		// peek() first — select() may mutate account state via
		// resetSessionIfExpired.
		expect(strategy.peek([drainEarly, drainLate])).toBe("drain-late");
		expect(strategy.select([drainEarly, drainLate], meta)[0].id).toBe(
			"drain-late",
		);
	});
});

// ---------------------------------------------------------------------------
// SOLL-Tests: the "strict" ranking mode (A11).
//
// One canonical comparator instead of the active-session pre-filter:
//   weekly_all reset ASC (unknown/past last)
//   → has active session (active before inactive)
//   → priority ASC → utilization ASC → account id (determinism anchor).
//
// session_start gates nothing anymore at position 0 — the active-session
// STATUS breaks weekly-reset ties; session-start recency is never compared.
// Normal case: the drain-earliest available account wins, active or not (no
// lock-out when a holder ages out of its 5h window). Tie case (cold cache
// after restart: all resets null): an ACTIVE account beats an inactive one,
// so the incumbent holder keeps the traffic instead of utilization-based
// spraying that would flush every account's prompt cache.
// ---------------------------------------------------------------------------

describe("SessionDrainSoonestStrategy — strict ranking mode (A11)", () => {
	let strategy: SessionDrainSoonestStrategy;
	let store: MockStrategyStore;

	beforeEach(() => {
		strategy = new SessionDrainSoonestStrategy(undefined, "strict");
		store = new MockStrategyStore();
		strategy.initialize(store);
	});

	it("select() picks the drain-earliest account even when another account has the youngest active session", () => {
		const now = Date.now();
		const drainEarly = makeAccount({
			id: "drain-early",
			name: "drain-early",
			session_start: now - 2 * HOUR,
		});
		const drainLate = makeAccount({
			id: "drain-late",
			name: "drain-late",
			session_start: now - 30 * 60 * 1000, // youngest — must NOT win
		});
		store.setWeeklyReset("drain-early", now + 1 * DAY);
		store.setWeeklyReset("drain-late", now + 6 * DAY);

		const result = strategy.select([drainLate, drainEarly], meta);
		expect(result.map((a) => a.id)).toEqual(["drain-early", "drain-late"]);
	});

	it("no lock-out: a drain-earliest holder that AGED OUT of its 5h window keeps winning and gets a fresh session", () => {
		const now = Date.now();
		// Held for >5h straight — under the sticky mode this account could
		// never win again until a probe re-opened its window (the observed
		// production lock-out).
		const agedOut = makeAccount({
			id: "aged-out",
			name: "aged-out",
			session_start: now - 6 * HOUR,
			session_request_count: 941,
		});
		const activeLater = makeAccount({
			id: "active-later",
			name: "active-later",
			session_start: now - 10 * 60 * 1000,
		});
		store.setWeeklyReset("aged-out", now + 1 * DAY);
		store.setWeeklyReset("active-later", now + 6 * DAY);

		const resetCalls: string[] = [];
		store.resetAccountSession = (accountId: string) => {
			resetCalls.push(accountId);
		};

		const result = strategy.select([activeLater, agedOut], meta);
		expect(result[0].id).toBe("aged-out");
		// Selecting it re-opens its window: exactly one store reset, and the
		// in-memory account reflects the fresh session.
		expect(resetCalls).toEqual(["aged-out"]);
		expect(agedOut.session_start).toBeGreaterThanOrEqual(now);
		expect(agedOut.session_request_count).toBe(0);
	});

	it("cold-cache tie: with all weekly resets unknown, an ACTIVE account beats an inactive one (no utilization spraying)", () => {
		const now = Date.now();
		const incumbent = makeAccount({
			id: "incumbent",
			name: "incumbent",
			session_start: now - 1 * HOUR, // the current holder
		});
		const idle = makeAccount({
			id: "idle",
			name: "idle",
			session_start: null,
		});
		// No weekly resets at all (usageCache cold after restart) — and the
		// utilizations deliberately favour the idle account, which must NOT
		// matter: activity outranks utilization in the tie chain.
		store.setUtilization("incumbent", 90);
		store.setUtilization("idle", 10);

		expect(strategy.peek([incumbent, idle])).toBe("incumbent");
		expect(strategy.select([incumbent, idle], meta)[0].id).toBe("incumbent");
	});

	it("full tie falls through priority → utilization → account id deterministically", () => {
		const now = Date.now();
		// The id-smaller account is deliberately the OLDER session: the
		// sticky mode would pick acc-b (youngest), so this discriminates
		// "account id decides" from "recency decides".
		const a = makeAccount({
			id: "acc-a",
			name: "acc-a",
			session_start: now - 2 * HOUR,
		});
		const b = makeAccount({
			id: "acc-b",
			name: "acc-b",
			session_start: now - 1 * HOUR,
		});
		// Same (missing) reset, both active, same priority, same utilization
		// → the account id decides, in both input orders.
		expect(strategy.select([b, a], meta)[0].id).toBe("acc-a");
		expect(
			strategy.select(
				[
					makeAccount({
						id: "acc-a",
						name: "acc-a",
						session_start: now - 2 * HOUR,
					}),
					makeAccount({
						id: "acc-b",
						name: "acc-b",
						session_start: now - 1 * HOUR,
					}),
				],
				meta,
			)[0].id,
		).toBe("acc-a");
	});

	it("peek() and select() agree in strict mode", () => {
		const now = Date.now();
		const drainEarly = makeAccount({
			id: "drain-early",
			name: "drain-early",
			session_start: null,
		});
		const drainLate = makeAccount({
			id: "drain-late",
			name: "drain-late",
			session_start: now - 5 * 60 * 1000,
		});
		store.setWeeklyReset("drain-early", now + 1 * DAY);
		store.setWeeklyReset("drain-late", now + 6 * DAY);

		expect(strategy.peek([drainLate, drainEarly])).toBe("drain-early");
		expect(strategy.select([drainLate, drainEarly], meta)[0].id).toBe(
			"drain-early",
		);
	});

	it("selecting an account without an active session starts one (resetAccountSession is called)", () => {
		const now = Date.now();
		const agedOut = makeAccount({
			id: "aged-out",
			name: "aged-out",
			session_start: null,
		});
		const activeLater = makeAccount({
			id: "active-later",
			name: "active-later",
			session_start: now - 10 * 60 * 1000,
		});
		store.setWeeklyReset("aged-out", now + 1 * DAY);
		store.setWeeklyReset("active-later", now + 6 * DAY);

		const calls: string[] = [];
		store.resetAccountSession = (accountId: string) => {
			calls.push(accountId);
		};

		strategy.select([activeLater, agedOut], meta);
		expect(calls).toContain("aged-out");
	});

	it("with equal reset and activity, priority beats better utilization and a smaller id", () => {
		const now = Date.now();
		const lowPrio = makeAccount({
			id: "acc-a", // smaller id — must NOT win
			name: "acc-a",
			priority: 5,
			session_start: now - 1 * HOUR,
		});
		const highPrio = makeAccount({
			id: "acc-z",
			name: "acc-z",
			priority: 0,
			session_start: now - 1 * HOUR,
		});
		store.setUtilization("acc-a", 10); // better utilization — must NOT win
		store.setUtilization("acc-z", 90);

		expect(strategy.select([lowPrio, highPrio], meta)[0].id).toBe("acc-z");
	});

	it("with equal reset, activity, and priority, lower utilization beats a smaller id", () => {
		const now = Date.now();
		const higherUtil = makeAccount({
			id: "acc-a", // smaller id — must NOT win
			name: "acc-a",
			session_start: now - 1 * HOUR,
		});
		const lowerUtil = makeAccount({
			id: "acc-z",
			name: "acc-z",
			session_start: now - 1 * HOUR,
		});
		store.setUtilization("acc-a", 90);
		store.setUtilization("acc-z", 10);

		expect(strategy.select([higherUtil, lowerUtil], meta)[0].id).toBe("acc-z");
	});

	it("the bypass header keeps strict ranking but suppresses the session mutation", () => {
		const now = Date.now();
		const agedOut = makeAccount({
			id: "aged-out",
			name: "aged-out",
			session_start: now - 6 * HOUR,
		});
		const activeLater = makeAccount({
			id: "active-later",
			name: "active-later",
			session_start: now - 10 * 60 * 1000,
		});
		store.setWeeklyReset("aged-out", now + 1 * DAY);
		store.setWeeklyReset("active-later", now + 6 * DAY);

		const resetCalls: string[] = [];
		store.resetAccountSession = (accountId: string) => {
			resetCalls.push(accountId);
		};

		const bypassMeta: RequestMeta = {
			...meta,
			headers: new Headers({ "x-better-ccflare-bypass-session": "true" }),
		};
		const result = strategy.select([activeLater, agedOut], bypassMeta);

		expect(result[0].id).toBe("aged-out"); // ranking unchanged
		expect(resetCalls).toEqual([]); // no session mutation
		expect(agedOut.session_start).toBe(now - 6 * HOUR);
	});

	it("the documented auto-fallback exception still forces position 0; its tail is strict-sorted", () => {
		const now = Date.now();
		const fallback = makeAccount({
			id: "fallback",
			name: "fallback",
			auto_fallback_enabled: true,
			rate_limit_reset: now - 60_000, // window reset has passed
			session_start: null,
		});
		// Tail discriminator: the drain-later account has the YOUNGER active
		// session — the sticky comparator would not reorder these two by
		// activity, but a recency-based tail would put drain-late first.
		const drainEarly = makeAccount({
			id: "drain-early",
			name: "drain-early",
			session_start: now - 2 * HOUR,
		});
		const drainLate = makeAccount({
			id: "drain-late",
			name: "drain-late",
			session_start: now - 10 * 60 * 1000,
		});
		store.setWeeklyReset("fallback", now + 6 * DAY);
		store.setWeeklyReset("drain-early", now + 1 * DAY);
		store.setWeeklyReset("drain-late", now + 3 * DAY);

		const result = strategy.select([drainLate, drainEarly, fallback], meta);
		expect(result.map((a) => a.id)).toEqual([
			"fallback",
			"drain-early",
			"drain-late",
		]);
	});
});
