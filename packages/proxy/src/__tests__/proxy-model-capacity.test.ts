import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "claude-primary",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60_000,
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

function makeContext(
	account: Account,
	opts: { capacityRoutingMode?: "off" | "exhausted" } = {},
): ProxyContext {
	return {
		strategy: {
			select: (accounts: Account[]) => accounts,
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () =>
				opts.capacityRoutingMode ?? "exhausted",
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

afterEach(() => {
	usageCache.delete("acc-1");
});

describe("handleProxy model-scoped capacity routing", () => {
	// v3 Fix4 (Revision v2, codex-8): 429, not 529 — Anthropic-compatible
	// error.type "rate_limit_error" + a separate machine-readable
	// error.code "model_family_exhausted".
	it("returns a structured 429 rate_limit_error/model_family_exhausted response when every account is capacity-exhausted for the request's family", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		usageCache.set(account.id, {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: resetAt,
					scope: { model: { id: null, display_name: "Sonnet" }, surface: null },
				},
			],
			// Overage confirmed unavailable — "unknown" would correctly fail open.
			spend: { enabled: false },
		} as never);

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			});

			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(429);
			const body = (await response.json()) as {
				type: string;
				error: {
					type: string;
					code: string;
					family: string;
					resetAt: number | null;
				};
			};
			expect(body.type).toBe("error");
			expect(body.error.type).toBe("rate_limit_error");
			expect(body.error.code).toBe("model_family_exhausted");
			expect(body.error.family).toBe("sonnet");
			expect(body.error.resetAt).toBe(new Date(resetAt).getTime());
		} finally {
			Date.now = realDateNow;
		}
	});

	// The "capacity routing off" / "account not excluded" behavior is covered
	// at the account-selector unit level (account-selector-model-capacity.test.ts
	// — "switch off" describe block), which doesn't require driving a request
	// all the way through proxyWithAccount/forwardToClient (and its
	// UsageCollector dependency, uninitialized in this narrower test file).
});

// ── v3 Revision v2 Fix3 (codex-1/2): Step-10 combo-fallback control flow ────────
//
// After every combo slot fails, proxy.ts's Step 10 clears combo state and
// re-selects. Passing NO model (today's behavior) makes the capacity filter a
// no-op on the fallback pool, so already-known-exhausted accounts get
// re-attempted instead of the request failing fast with a structured
// model_family_exhausted response — and the capacity-exhaustion result from
// that re-selection is not checked at all (only throttled accounts are),
// so the request ultimately falls through to a generic failure instead of
// the structured 429.

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

// 429 with the out_of_credits overage-disabled-reason header — the same
// model/beta-scoped-depletion signal exercised in
// proxy-operations-out-of-credits.test.ts. Causes proxyWithAccount to fail
// over per-request (return null) WITHOUT benching the account, and feeds the
// model-capacity negative cache for the requested model's family.
function outOfCreditsResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "request rate limit exceeded",
			},
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
				"x-should-retry": "true",
			},
		},
	);
}

function makeComboContext(
	accounts: Account[],
	combo: ComboWithSlots,
): ProxyContext {
	return {
		strategy: { select: mock((accs: Account[]) => accs) } as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => combo),
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "exhausted",
			getStorePayloads: () => true,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://api.anthropic.com/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	};
}

function makeComboAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-x",
		name: "acc-x",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
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

describe("handleProxy Step-10 combo-fallback control flow (v3 Fix3)", () => {
	afterEach(() => {
		usageCache.clear();
		delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
	});

	it("does not re-attempt the just-failed combo accounts unfiltered — the Step-10 fallback re-selection applies the capacity filter and returns the structured model_family_exhausted response instead of a generic failure", async () => {
		const acc1 = makeComboAccount({ id: "acc-1", name: "acc-1" });
		const acc2 = makeComboAccount({ id: "acc-2", name: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		// Both accounts reject every request with out_of_credits for the
		// duration of the test — this both fails the initial combo attempts AND
		// (via the reactive negative cache) marks acc-1/acc-2 exhausted for
		// "sonnet" DURING that same combo loop, before Step 10 ever runs.
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeComboContext([acc1, acc2], combo);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});

		let response: Response | undefined;
		let thrown: unknown;
		try {
			response = await handleProxy(request, new URL(request.url), ctx);
		} catch (error) {
			thrown = error;
		}

		// Must resolve to the structured 429, not reject with a generic
		// "all accounts failed" ServiceUnavailableError from blindly retrying
		// acc-1/acc-2 a second time on the unfiltered Step-10 fallback pool.
		expect(thrown).toBeUndefined();
		expect(response?.status).toBe(429);
		const body = (await response?.json()) as {
			error?: { type?: string; code?: string };
		};
		expect(body.error?.type).toBe("rate_limit_error");
		expect(body.error?.code).toBe("model_family_exhausted");
	});

	it("clears comboName so Step-10's own capacity-filtered selection is not itself treated as a fresh combo lookup (no stale combo state after fallthrough)", async () => {
		const acc1 = makeComboAccount({ id: "acc-1", name: "acc-1" });
		const acc2 = makeComboAccount({ id: "acc-2", name: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeComboContext([acc1, acc2], combo);
		const getActiveComboForFamily = ctx.dbOps
			.getActiveComboForFamily as ReturnType<typeof mock>;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});

		try {
			await handleProxy(request, new URL(request.url), ctx);
		} catch {
			// Failure mode is asserted in the sibling test above; here we only
			// care about how many times the combo lookup fired.
		}

		// Exactly ONE combo lookup for the whole request: the initial selection.
		// Step 10 must use skipCombo and never re-trigger getActiveComboForFamily.
		expect(getActiveComboForFamily.mock.calls.length).toBe(1);
	});

	it("can disable Step-10 SessionStrategy fallback after combo slots fail", async () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		const handleStart = mock(() => {});
		const handleEnd = mock(() => Promise.resolve());
		const collectorSpy = spyOn(
			usageCollectorModule,
			"tryGetUsageCollector",
		).mockReturnValue({
			handleStart,
			handleEnd,
			handleChunk: mock(() => {}),
		} as unknown as usageCollectorModule.UsageCollector);

		const acc1 = makeComboAccount({ id: "acc-1", name: "acc-1" });
		const acc2 = makeComboAccount({ id: "acc-2", name: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		globalThis.fetch = mock(
			async () => outOfCreditsResponse(),
		);

		const ctx = makeComboContext([acc1, acc2], combo);
		ctx.config.getModelScopedCapacityRouting = () => "off";
		const select = ctx.strategy.select as ReturnType<typeof mock>;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});

		try {
			const response = await handleProxy(request, new URL(request.url), ctx);
			const body = (await response.json()) as {
				error?: { code?: string };
			};

			expect(response.status).toBe(503);
			expect(body.error?.code).toBe("combo_session_fallback_disabled");
			expect(handleStart).toHaveBeenCalledTimes(1);
			expect(handleStart.mock.calls[0]?.[0]).toMatchObject({
				responseStatus: 503,
				comboName: "Test Combo",
				failoverAttempts: 2,
			});
			expect(handleEnd).toHaveBeenCalledTimes(1);
			expect(handleEnd.mock.calls[0]?.[0]).toMatchObject({
				success: false,
				error: "combo_session_fallback_disabled",
			});
		} finally {
			collectorSpy.mockRestore();
		}

		// Combo selection only. Step-10 must not re-enter the global pool.
		expect(select.mock.calls.length).toBe(0);
	});
});
