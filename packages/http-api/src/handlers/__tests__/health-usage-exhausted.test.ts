import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { computePoolStatus, createHealthHandler } from "../health";

/**
 * Incident 2026-07-09: /health reported `routable: 2` and the dashboard showed
 * `rateLimitStatus: OK` for MAX_200_ALT_2 while the account's weekly usage
 * window sat at 100% (every request 429'd upstream) and /v1/messages returned
 * 503 pool_exhausted. `routable` must keep its meaning (unpaused + no active
 * cooldown), but the pool status has to EXPOSE usage-exhausted accounts so the
 * two readings stop contradicting each other.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc",
		name: "acc",
		provider: "anthropic",
		paused: false,
		rate_limited_until: null,
		...overrides,
	} as Account;
}

describe("computePoolStatus — usage_exhausted counter", () => {
	const now = Date.UTC(2026, 6, 9, 2, 30, 0);

	it("counts unpaused accounts whose representative utilization is >= 100", () => {
		// Incident constellation: MAIN+ALT paused, ALT_2 weekly 100%, ALT_3 41%.
		const accounts = [
			makeAccount({ id: "main", name: "MAX_200_MAIN", paused: true }),
			makeAccount({ id: "alt", name: "MAX_200_ALT", paused: true }),
			makeAccount({ id: "alt2", name: "MAX_200_ALT_2" }),
			makeAccount({ id: "alt3", name: "MAX_200_ALT_3" }),
		];
		const utilization: Record<string, number> = {
			main: 76,
			alt: 100, // paused — already visible as paused, must not double-count
			alt2: 100,
			alt3: 41,
		};

		const status = computePoolStatus(accounts, now, (account) =>
			utilization[account.id] != null
				? { utilization: utilization[account.id], resetMs: now + 3_600_000 }
				: null,
		);

		expect(status.usage_exhausted).toBe(1);
		// routable keeps its existing meaning — ALT_2 has no active cooldown,
		// so it still counts. The contradiction becomes visible instead of
		// hidden: routable 2, of which 1 is usage-exhausted.
		expect(status.routable).toBe(2);
		expect(status.paused).toBe(2);
		expect(status.rate_limited).toBe(0);
	});

	it("reports 0 when no utilization source is provided (backward compatible)", () => {
		const status = computePoolStatus([makeAccount()], now);
		expect(status.usage_exhausted).toBe(0);
		expect(status.routable).toBe(1);
	});

	it("treats null usage info (no usage data) as not exhausted", () => {
		const status = computePoolStatus([makeAccount()], now, () => null);
		expect(status.usage_exhausted).toBe(0);
	});

	it("does NOT count an account whose known usage reset lies in the past (stale snapshot)", () => {
		// Same staleness guard as the rateLimitStatus display — otherwise the
		// two surfaces contradict each other for up to a cache interval after
		// a window reset (cross-LLM review consensus finding).
		const status = computePoolStatus([makeAccount()], now, () => ({
			utilization: 100,
			resetMs: now - 1,
		}));
		expect(status.usage_exhausted).toBe(0);
	});
});

describe("createHealthHandler — pool.usage_exhausted in the response", () => {
	const dbWith = (accounts: Partial<Account>[]) =>
		({
			getAllAccounts: async () => accounts,
		}) as unknown as import("@better-ccflare/database").DatabaseOperations;
	const config = {
		getStrategy: () => "session",
	} as unknown as import("@better-ccflare/config").Config;

	afterEach(() => {
		usageCache.delete("health-test-exhausted");
		usageCache.delete("health-test-stale");
	});

	it("exposes usage_exhausted via an injected utilization source", async () => {
		const handler = createHealthHandler(
			dbWith([
				{ id: "a1", name: "a1", provider: "anthropic", paused: false },
				{ id: "a2", name: "a2", provider: "anthropic", paused: false },
			]),
			config,
			undefined,
			undefined,
			undefined,
			(account) => ({
				utilization: account.id === "a2" ? 100 : 10,
				resetMs: null,
			}),
		);

		const response = await handler(new URL("http://localhost/health"));
		const body = (await response.json()) as {
			pool: { routable: number; usage_exhausted: number };
		};

		expect(body.pool.routable).toBe(2);
		expect(body.pool.usage_exhausted).toBe(1);
	});

	it("defaults to the shared usageCache (no wiring changes at call sites)", async () => {
		usageCache.set("health-test-exhausted", {
			five_hour: { utilization: 12, resets_at: null },
			seven_day: {
				utilization: 100,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
		});

		const handler = createHealthHandler(
			dbWith([
				{
					id: "health-test-exhausted",
					name: "exhausted",
					provider: "anthropic",
					paused: false,
				},
			]),
			config,
		);

		const response = await handler(new URL("http://localhost/health"));
		const body = (await response.json()) as {
			pool: { routable: number; usage_exhausted: number };
		};

		expect(body.pool.routable).toBe(1);
		expect(body.pool.usage_exhausted).toBe(1);
	});

	it("default path applies the staleness guard (reset in the past — not exhausted)", async () => {
		usageCache.set("health-test-stale", {
			five_hour: { utilization: 12, resets_at: null },
			seven_day: {
				utilization: 100,
				resets_at: new Date(Date.now() - 60_000).toISOString(),
			},
		});

		const handler = createHealthHandler(
			dbWith([
				{
					id: "health-test-stale",
					name: "stale",
					provider: "anthropic",
					paused: false,
				},
			]),
			config,
		);

		const response = await handler(new URL("http://localhost/health"));
		const body = (await response.json()) as {
			pool: { usage_exhausted: number };
		};

		expect(body.pool.usage_exhausted).toBe(0);
	});
});
