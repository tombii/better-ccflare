import { beforeEach, describe, expect, it } from "bun:test";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: "t",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
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
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

class MockStore implements StrategyStore {
	resetCalls: Array<{ accountId: string; timestamp: number }> = [];
	resumeCalls: string[] = [];
	utilization: Map<string, number | null> = new Map();

	resetAccountSession(accountId: string, timestamp: number): void {
		this.resetCalls.push({ accountId, timestamp });
	}
	resumeAccount(accountId: string): void {
		this.resumeCalls.push(accountId);
	}
	getAccountUtilization(accountId: string): number | null {
		return this.utilization.has(accountId)
			? (this.utilization.get(accountId) ?? null)
			: null;
	}
	setUtil(accountId: string, value: number | null): void {
		this.utilization.set(accountId, value);
	}
}

function metaFor(clientSessionId?: string | null): RequestMeta {
	return {
		id: "req",
		headers: new Headers(),
		timestamp: Date.now(),
		clientSessionId: clientSessionId ?? null,
	} as unknown as RequestMeta;
}

describe("SessionAffinityStrategy", () => {
	let store: MockStore;
	let strategy: SessionAffinityStrategy;

	beforeEach(() => {
		store = new MockStore();
		strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
	});

	it("assigns a new client an account and sticks it there (sticky)", () => {
		const accounts = [
			makeAccount({ id: "x" }),
			makeAccount({ id: "y" }),
			makeAccount({ id: "z" }),
		];

		const first = strategy.select(accounts, metaFor("client-1"));
		const assigned = first[0].id;

		// Subsequent selects with the same client id must keep returning the
		// same account first, even though util/recency would otherwise rotate.
		for (let i = 0; i < 5; i++) {
			const next = strategy.select(accounts, metaFor("client-1"));
			expect(next[0].id).toBe(assigned);
		}
	});

	it("spreads two different clients onto different accounts", () => {
		// Two equal accounts (priority 0, util 0). The recency penalty must push
		// the second new client onto the other account.
		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];

		const a = strategy.select(accounts, metaFor("client-a"))[0].id;
		const b = strategy.select(accounts, metaFor("client-b"))[0].id;

		expect(a).not.toBe(b);
		expect(new Set([a, b])).toEqual(new Set(["x", "y"]));
	});

	it("temporarily fails over when the pinned account is unavailable but keeps the mapping (snap-back)", () => {
		const x = makeAccount({ id: "x" });
		const y = makeAccount({ id: "y" });
		store.setUtil("x", 0);
		store.setUtil("y", 0);

		// Pin client-1 to whichever account it gets (force it to x via util).
		store.setUtil("x", 0);
		store.setUtil("y", 50);
		const assigned = strategy.select([x, y], metaFor("client-1"))[0].id;
		expect(assigned).toBe("x");

		// x becomes rate-limited.
		const xDown = makeAccount({
			id: "x",
			rate_limited_until: Date.now() + 60_000,
		});
		const failover = strategy.select([xDown, y], metaFor("client-1"));
		// Must route to an available account (y), not the down one.
		expect(failover[0].id).toBe("y");
		expect(failover.every((a) => a.id !== "x")).toBe(true);

		// x recovers → client snaps back to x (mapping was never deleted).
		const recovered = strategy.select(
			[makeAccount({ id: "x" }), y],
			metaFor("client-1"),
		);
		expect(recovered[0].id).toBe("x");
	});

	it("falls back to least-used when no clientSessionId is present", () => {
		store.setUtil("low", 10);
		store.setUtil("high", 90);
		const accounts = [makeAccount({ id: "high" }), makeAccount({ id: "low" })];

		const ordered = strategy.select(accounts, metaFor(null));
		expect(ordered[0].id).toBe("low");
		expect(ordered.map((a) => a.id).sort()).toEqual(["high", "low"]);
	});

	it("GCs an expired affinity mapping and reassigns", () => {
		// Tiny TTL so the mapping expires between selects.
		const ttlStrategy = new SessionAffinityStrategy(1);
		ttlStrategy.initialize(store);

		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];

		const first = ttlStrategy.select(accounts, metaFor("client-1"))[0].id;

		// Let the TTL elapse.
		const start = Date.now();
		while (Date.now() - start < 5) {
			/* busy-wait a few ms so now - assignedAt >= 1ms TTL */
		}

		// Make the *other* account strictly preferable so reassignment is
		// observable: if the old mapping were honoured we'd still get `first`.
		const other = first === "x" ? "y" : "x";
		store.setUtil(first, 90);
		store.setUtil(other, 0);

		const second = ttlStrategy.select(accounts, metaFor("client-1"))[0].id;
		expect(second).toBe(other);
	});

	it("returns [] when all accounts are unavailable", () => {
		const accounts = [
			makeAccount({ id: "p1", paused: true }),
			makeAccount({ id: "rl1", rate_limited_until: Date.now() + 60_000 }),
		];
		expect(strategy.select(accounts, metaFor("client-1"))).toEqual([]);
	});

	describe("peek", () => {
		it("returns the least-used available account id", () => {
			store.setUtil("low", 10);
			store.setUtil("high", 90);
			const accounts = [
				makeAccount({ id: "high" }),
				makeAccount({ id: "low" }),
			];
			expect(strategy.peek(accounts)).toBe("low");
		});

		it("returns null when no accounts are available", () => {
			expect(
				strategy.peek([
					makeAccount({ id: "p1", paused: true }),
					makeAccount({ id: "rl1", rate_limited_until: Date.now() + 60_000 }),
				]),
			).toBeNull();
		});
	});
});
