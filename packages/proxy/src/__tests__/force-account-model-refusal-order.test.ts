/**
 * Where the `force_account_model` refusal sits among the other empty-pool
 * answers.
 *
 * The refusal says "nothing can serve the model you asked for". That is a
 * statement about capability, and it must not be made when the real reason the
 * pool is empty is capacity: an account that speaks the requested model
 * perfectly well but is out of quota for the next forty minutes is a temporary,
 * actionable state, and the exhaustion/throttling answers carry the `resetAt`
 * and `Retry-After` that say when to come back. Answering the refusal over them
 * would replace a fact with a falsehood and drop the retry time on the floor.
 *
 * So the refusal answers last among the structured responses — and still ahead
 * of the generic `pool_exhausted` 503, which is the case it genuinely improves
 * on by naming the model that went unserved.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		// "anthropic" on purpose: it speaks Claude model ids, so the force-mode
		// compatibility filter keeps it. Whatever empties the pool below is
		// therefore capacity, never capability.
		id: "acc-1",
		name: "anthropic-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
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
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeContext(
	accounts: Account[],
	opts?: { throttlingEnabled?: boolean },
): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => opts?.throttlingEnabled ?? false,
			getUsageThrottlingWeeklyEnabled: () => opts?.throttlingEnabled ?? false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getForceAccountModel: () => true,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

/**
 * A five-hour window well ahead of its pacing line, mirroring the shape
 * `proxy-usage-throttling.test.ts` already pins.
 */
const FROZEN_NOW = Date.UTC(2026, 3, 28, 12, 0, 0);

function throttledUsage() {
	return {
		five_hour: {
			utilization: 80,
			resets_at: new Date(FROZEN_NOW + 2 * 60 * 60 * 1000).toISOString(),
		},
		seven_day: { utilization: 10, resets_at: null },
	};
}

let savedPassthrough: string | undefined;

beforeEach(() => {
	savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	usageCache.clear();
	stubUsageCollector();
});

afterEach(() => {
	usageCache.clear();
	if (savedPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
	}
});

describe("force_account_model refusal — ordering against capacity answers", () => {
	it("yields to the usage-throttling answer, which carries the retry time", async () => {
		const account = makeAccount();
		usageCache.set(account.id, throttledUsage() as never);
		const ctx = makeContext([account], { throttlingEnabled: true });

		const realDateNow = Date.now;
		Date.now = () => FROZEN_NOW;
		let response: Response;
		try {
			response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
		} finally {
			Date.now = realDateNow;
		}

		// The account speaks this model; it is only out of pace right now. The
		// throttling answer says when to come back — the refusal would not.
		expect(response.status).toBe(529);
		expect(response.headers.get("Retry-After")).not.toBeNull();

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.code).not.toBe("force_account_model_no_account");
	});

	it("still answers when the pool is empty with no capacity explanation", async () => {
		const ctx = makeContext([]);

		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.code).toBe("force_account_model_no_account");
		// Naming the model is the whole point of answering here rather than
		// letting the generic pool_exhausted 503 through.
		expect(JSON.stringify(error)).toContain("claude-sonnet-4-5");
	});

	it("beats the generic pool_exhausted 503 when throttling is off", async () => {
		const account = makeAccount({ paused: true });
		const ctx = makeContext([account]);

		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.code).toBe("force_account_model_no_account");
		expect(error.type).not.toBe("pool_exhausted");
	});
});
