import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchOpenRouterUsageData } from "../openrouter-usage-fetcher";

const originalFetch = globalThis.fetch;

const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
const CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";

/** Route /api/v1/key and /api/v1/credits to distinct canned responses. */
function mockEndpoints(
	key: { body: unknown; status?: number; statusText?: string },
	credits?: { body: unknown; status?: number; statusText?: string },
) {
	const calls: string[] = [];
	globalThis.fetch = mock(async (input: RequestInfo) => {
		const url = String(input);
		calls.push(url);
		const match = url.includes("/credits") ? credits : key;
		if (!match) throw new Error(`unexpected request: ${url}`);
		return new Response(JSON.stringify(match.body), {
			status: match.status ?? 200,
			statusText: match.statusText ?? "OK",
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return calls;
}

function mockJsonResponse(body: unknown, status = 200, statusText = "OK") {
	globalThis.fetch = mock(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				statusText,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("OpenRouter Usage Fetcher", () => {
	describe("fetchOpenRouterUsageData", () => {
		it("reads limit_remaining/limit/usage from the key endpoint payload", async () => {
			mockJsonResponse({
				data: {
					label: "sk-or-v1-au7...890",
					limit: 100,
					limit_remaining: 74.5,
					limit_reset: "monthly",
					usage: 25.5,
					usage_monthly: 25.5,
					is_free_tier: false,
					effective_budget: {
						limit_usd: 50,
						remaining_usd: 17.5,
						spend_usd: 32.5,
						reset_interval: "weekly",
					},
				},
			});

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data).not.toBeNull();
			// Key's own allowance wins over the separate effective_budget guardrail.
			expect(data?.limitUsd).toBe(100);
			expect(data?.remainingUsd).toBe(74.5);
			expect(data?.usageUsd).toBe(25.5);
			expect(data?.balanceScope).toBe("key");
			expect(data?.resetInterval).toBe("monthly");
		});

		it("derives utilization from the current period, not lifetime usage", async () => {
			// A monthly-reset key that has spent $260 over its life against a
			// $100 monthly cap, with $40 left this period. Using lifetime usage
			// would report 260% and bench a usable account.
			mockJsonResponse({
				data: {
					limit: 100,
					limit_remaining: 40,
					limit_reset: "monthly",
					usage: 260,
					usage_monthly: 60,
				},
			});

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data?.remainingUsd).toBe(40);
			// (100 - 40) / 100 = 60% — this period's spend, not 260%.
			expect(data?.utilizationPercent).toBeCloseTo(60, 5);
		});

		it("prefers the period counter matching limit_reset when limit_remaining is absent", async () => {
			mockJsonResponse({
				data: {
					limit: 100,
					limit_reset: "weekly",
					usage: 999,
					usage_weekly: 25,
					usage_monthly: 80,
				},
			});

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data?.utilizationPercent).toBeCloseTo(25, 5);
		});

		it("falls back to lifetime usage when the limit does not reset", async () => {
			mockJsonResponse({ data: { limit: 50, usage: 10 } });

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data?.resetInterval).toBeNull();
			expect(data?.utilizationPercent).toBeCloseTo(20, 5);
		});

		it("reads the reset time from the key_limit budget", async () => {
			const resetsAt = "2026-11-01T00:00:00.000Z";
			mockJsonResponse({
				data: {
					limit: 100,
					limit_remaining: 74.5,
					limit_reset: "monthly",
					usage: 25.5,
					budgets: [
						{ scope: "member", reset_interval: "weekly", resets_at: null },
						{
							scope: "key_limit",
							reset_interval: "monthly",
							resets_at: resetsAt,
						},
					],
					effective_budget: { scope: "member", resets_at: null },
				},
			});

			const data = await fetchOpenRouterUsageData("sk-or-test");
			// Must come from the key_limit entry, not the member guardrail.
			expect(data?.resetsAt).toBe(resetsAt);
		});

		it("falls back to account credits when the key has no budget", async () => {
			// Mirrors the real unlimited-key payload: limit/limit_remaining null,
			// empty budgets, null effective_budget.
			const calls = mockEndpoints(
				{
					body: {
						data: {
							limit: null,
							limit_remaining: null,
							budgets: [],
							effective_budget: null,
							usage: 0,
						},
					},
				},
				{ body: { data: { total_credits: 35, total_usage: 0.6032405 } } },
			);

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(calls).toEqual([KEY_ENDPOINT, CREDITS_ENDPOINT]);
			// No key-level limit, but the account pool is still surfaced.
			expect(data?.limitUsd).toBeNull();
			expect(data?.remainingUsd).toBeCloseTo(34.3967595, 6);
			expect(data?.usageUsd).toBeCloseTo(0.6032405, 6);
			expect(data?.balanceScope).toBe("account");
			// An account pool has no depletion window, so it must contribute no
			// utilization — otherwise it could gate the account out of selection.
			expect(data?.utilizationPercent).toBeNull();
			expect(data?.resetInterval).toBeNull();
			expect(data?.resetsAt).toBeNull();
		});

		it("does not call the credits endpoint when the key has a limit", async () => {
			const calls = mockEndpoints({
				body: { data: { limit: 5, limit_remaining: 5, usage: 0 } },
			});

			await fetchOpenRouterUsageData("sk-or-test");
			expect(calls).toEqual([KEY_ENDPOINT]);
		});

		it("reports an unknown balance when an unlimited key's credits lookup fails", async () => {
			mockEndpoints(
				{ body: { data: { limit: null, limit_remaining: null, usage: 3 } } },
				{ body: { error: "boom" }, status: 500, statusText: "Server Error" },
			);

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data?.limitUsd).toBeNull();
			expect(data?.remainingUsd).toBeNull();
			expect(data?.balanceScope).toBe("unknown");
			expect(data?.utilizationPercent).toBeNull();
		});

		it("clamps account credits at zero when usage exceeds the pool", async () => {
			mockEndpoints(
				{ body: { data: { limit: null, limit_remaining: null, usage: 0 } } },
				{ body: { data: { total_credits: 10, total_usage: 12.5 } } },
			);

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data?.remainingUsd).toBe(0);
		});

		it("derives remaining from limit - usage when limit_remaining is absent", async () => {
			mockJsonResponse({ data: { limit: 20, usage: 5 } });

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data?.remainingUsd).toBe(15);
			expect(data?.balanceScope).toBe("key");
		});

		it("sends the key as a bearer token to /api/v1/key", async () => {
			let calledUrl = "";
			let authHeader: string | null = null;
			globalThis.fetch = mock(
				async (input: RequestInfo, init?: RequestInit) => {
					calledUrl = String(input);
					authHeader = new Headers(init?.headers).get("authorization");
					return new Response(
						JSON.stringify({ data: { limit: 1, usage: 0 } }),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				},
			) as unknown as typeof fetch;

			await fetchOpenRouterUsageData("sk-or-secret");
			expect(calledUrl).toBe(KEY_ENDPOINT);
			expect(authHeader).toBe("Bearer sk-or-secret");
		});

		it("returns null on a non-OK key response", async () => {
			mockJsonResponse({ error: "unauthorized" }, 401, "Unauthorized");

			const data = await fetchOpenRouterUsageData("sk-or-bad");
			expect(data).toBeNull();
		});

		it("returns null when the request throws", async () => {
			globalThis.fetch = mock(async () => {
				throw new Error("network down");
			}) as unknown as typeof fetch;

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(data).toBeNull();
		});

		it("aborts a stalled request instead of hanging the poll slot", async () => {
			// A fetch that never settles must be cut off by the abort deadline,
			// otherwise UsageCache keeps reusing this in-flight promise and the
			// account's balance freezes for good.
			let sawAbort = false;
			globalThis.fetch = mock(
				async (_input: RequestInfo, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							sawAbort = true;
							reject(new DOMException("aborted", "AbortError"));
						});
					}),
			) as unknown as typeof fetch;

			const data = await fetchOpenRouterUsageData("sk-or-test");
			expect(sawAbort).toBe(true);
			expect(data).toBeNull();
		}, 15_000);
	});
});
