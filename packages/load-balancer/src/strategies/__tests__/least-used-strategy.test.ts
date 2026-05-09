import { beforeEach, describe, expect, it } from "bun:test";
import { LeastUsedStrategy } from "@better-ccflare/load-balancer";
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

const meta: RequestMeta = {
	id: "req-1",
	headers: new Headers(),
	timestamp: Date.now(),
} as unknown as RequestMeta;

describe("LeastUsedStrategy", () => {
	let store: MockStore;
	let strategy: LeastUsedStrategy;

	beforeEach(() => {
		store = new MockStore();
		strategy = new LeastUsedStrategy();
		strategy.initialize(store);
	});

	it("returns [] when all accounts are unavailable", () => {
		const accounts = [
			makeAccount({ id: "p1", paused: true }),
			makeAccount({
				id: "rl1",
				rate_limited_until: Date.now() + 60_000,
			}),
		];
		expect(strategy.select(accounts, meta)).toEqual([]);
	});

	it("orders by priority ASC (lower number first)", () => {
		const accounts = [
			makeAccount({ id: "p2", priority: 2 }),
			makeAccount({ id: "p0", priority: 0 }),
			makeAccount({ id: "p1", priority: 1 }),
		];
		const ordered = strategy.select(accounts, meta);
		expect(ordered.map((a) => a.id)).toEqual(["p0", "p1", "p2"]);
	});

	it("breaks priority ties by utilization ASC", () => {
		store.setUtil("low", 10);
		store.setUtil("med", 50);
		store.setUtil("high", 90);
		const accounts = [
			makeAccount({ id: "high" }),
			makeAccount({ id: "low" }),
			makeAccount({ id: "med" }),
		];
		const ordered = strategy.select(accounts, meta);
		expect(ordered.map((a) => a.id)).toEqual(["low", "med", "high"]);
	});

	it("treats null utilization as 0 (newly-added accounts win ties)", () => {
		// 'fresh' has no utilization data; 'used' is at 30%.
		store.setUtil("used", 30);
		const accounts = [
			makeAccount({ id: "used" }),
			makeAccount({ id: "fresh" }),
		];
		const ordered = strategy.select(accounts, meta);
		expect(ordered[0].id).toBe("fresh");
	});

	it("falls back to priority-only ordering when initialize() was not called", () => {
		const noStoreStrategy = new LeastUsedStrategy();
		const accounts = [
			makeAccount({ id: "low", priority: 5 }),
			makeAccount({ id: "high", priority: 0 }),
		];
		const ordered = noStoreStrategy.select(accounts, meta);
		expect(ordered.map((a) => a.id)).toEqual(["high", "low"]);
	});

	it("rotates concurrent picks via the recency penalty", () => {
		// Three equal accounts (priority 0, util 0) — without the recency
		// penalty, every select() would pick the same first-in-array account.
		// The penalty must shift the picked account to the back of subsequent
		// selects within RECENT_PICK_WINDOW_MS.
		const accounts = [
			makeAccount({ id: "x" }),
			makeAccount({ id: "y" }),
			makeAccount({ id: "z" }),
		];

		const first = strategy.select(accounts, meta);
		const second = strategy.select(accounts, meta);
		const third = strategy.select(accounts, meta);

		const firstPrimary = first[0].id;
		const secondPrimary = second[0].id;
		const thirdPrimary = third[0].id;

		// Each consecutive primary must differ from the previous one.
		expect(secondPrimary).not.toBe(firstPrimary);
		expect(thirdPrimary).not.toBe(secondPrimary);
		// Across three selects we should have hit at least 2 distinct accounts.
		expect(
			new Set([firstPrimary, secondPrimary, thirdPrimary]).size,
		).toBeGreaterThanOrEqual(2);
	});

	describe("auto-unpause", () => {
		it("resumes overage-paused accounts whose rate_limit_reset has elapsed", () => {
			const past = Date.now() - 60_000;
			const account = makeAccount({
				id: "ovg",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: past,
			});
			const ordered = strategy.select([account], meta);
			expect(account.paused).toBe(false);
			expect(store.resumeCalls).toContain("ovg");
			expect(ordered.map((a) => a.id)).toEqual(["ovg"]);
		});

		it("does NOT resume manually-paused accounts", () => {
			const past = Date.now() - 60_000;
			const account = makeAccount({
				id: "manual",
				paused: true,
				pause_reason: "manual",
				auto_fallback_enabled: true,
				rate_limit_reset: past,
			});
			const ordered = strategy.select([account], meta);
			expect(account.paused).toBe(true);
			expect(store.resumeCalls).not.toContain("manual");
			expect(ordered).toEqual([]);
		});

		it("does NOT resume accounts without auto_fallback_enabled", () => {
			const past = Date.now() - 60_000;
			const account = makeAccount({
				id: "no-flag",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: false,
				rate_limit_reset: past,
			});
			strategy.select([account], meta);
			expect(account.paused).toBe(true);
			expect(store.resumeCalls).not.toContain("no-flag");
		});

		it("does NOT resume when rate_limit_reset is still in the future", () => {
			const future = Date.now() + 60_000;
			const account = makeAccount({
				id: "future",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: future,
			});
			strategy.select([account], meta);
			expect(account.paused).toBe(true);
			expect(store.resumeCalls).not.toContain("future");
		});
	});
});
