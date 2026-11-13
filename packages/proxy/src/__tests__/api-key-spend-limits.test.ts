/**
 * Spend-limit enforcement at the handleProxy level.
 *
 * The refusal is a 429 `rate_limit_error` with code `api_key_limit_exceeded`,
 * decided before any upstream is contacted AND before account selection, and
 * recorded through `returnRefusal` so it lands in request history rather than
 * vanishing. Warn mode never refuses. Internal probes and zero-key mode are
 * exempt, matching the restriction carve-outs.
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
import * as core from "@better-ccflare/core";
import { spendLimitEvents } from "@better-ccflare/core";
import { usageCache } from "@better-ccflare/providers";
import type {
	Account,
	ApiKeyLimit,
	ApiKeySpendLimit,
} from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	getApiKeySpendCounter,
	resetApiKeySpendCounter,
} from "../handlers/api-key-spend";
import { INTERNAL_PROBE_SECRET_HEADER } from "../handlers/proxy-types";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

const SECRET = "probe-secret-for-spend-limit-tests";

let collectorStart: ReturnType<typeof mock>;
let collectorEnd: ReturnType<typeof mock>;

function stubUsageCollector() {
	collectorStart = mock(() => {});
	collectorEnd = mock(() => Promise.resolve());
	const stub = {
		handleStart: collectorStart,
		handleChunk: mock(() => {}),
		handleEnd: collectorEnd,
	} as unknown as usageCollectorModule.UsageCollector;
	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(stub);
	spyOn(usageCollectorModule, "tryGetUsageCollector").mockReturnValue(stub);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
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
	} as unknown as Account;
}

/**
 * `spend` is what the fake rollup query reports, i.e. what the counter seeds
 * from. `spendQueries` counts how often that rollup actually ran.
 */
function makeContext(
	accounts: Account[],
	spend: { totalUsd: number; oldestMs: number | null } = {
		totalUsd: 0,
		oldestMs: null,
	},
): ProxyContext & { spendQueries: { count: number } } {
	const spendQueries = { count: 0 };
	const ctx = {
		strategy: {
			select: (candidates: Account[]) => {
				const now = Date.now();
				return candidates.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference: mock(async () => null),
			listApiKeysWithSpendLimits: mock(async () => []),
			getApiKeySpendSince: mock(async () => {
				spendQueries.count++;
				return spend;
			}),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getWebSearchEnabled: () => false,
			getWebSearchBypassHeader: () => true,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getForceAccountModel: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
		} as never,
		internalProbeSecret: SECRET,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	} as unknown as ProxyContext;
	return Object.assign(ctx, { spendQueries });
}

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-opus-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function spendLimit(
	overrides: Partial<ApiKeySpendLimit> = {},
): ApiKeySpendLimit {
	return {
		limitUsd: 100,
		limitWindow: "rolling_30d",
		limitEnforce: "block",
		...overrides,
	};
}

const PROXY_URL = new URL("https://proxy.local/v1/messages");

let savedPassthrough: string | undefined;

beforeEach(() => {
	savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	usageCache.clear();
	resetApiKeySpendCounter();
	stubUsageCollector();
	spyOn(core, "getModelRates").mockResolvedValue({
		input: 5,
		output: 25,
		cacheRead: null,
		cacheWrite: null,
	});
});

afterEach(() => {
	// The tests spy on globalThis.fetch; restore it, or every later test file in the
	// same `bun test` run gets the stub (17 unrelated failures in the full suite).
	mock.restore();
	usageCache.clear();
	resetApiKeySpendCounter();
	if (savedPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
	}
});

describe("under the limit", () => {
	it("does not refuse", async () => {
		const ctx = makeContext([], { totalUsd: 20, oldestMs: null });

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100 }) },
		);

		// No accounts configured, so this ends as a pool refusal — the point is
		// only that it is NOT the spend-limit one.
		expect(response.status).not.toBe(429);
		const body = (await response.json()) as {
			error?: { code?: string };
		};
		expect(body.error?.code).not.toBe("api_key_limit_exceeded");
	});
});

describe("over the limit with enforce = block", () => {
	it("refuses with a 429 rate_limit_error carrying the full envelope", async () => {
		const now = Date.now();
		const oldest = now - 29 * 24 * 60 * 60 * 1000;
		const ctx = makeContext([makeAccount()], {
			totalUsd: 150.5,
			oldestMs: oldest,
		});

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100 }) },
		);

		expect(response.status).toBe(429);
		const body = (await response.json()) as {
			type: string;
			error: Record<string, unknown>;
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.code).toBe("api_key_limit_exceeded");
		expect(body.error.limit_usd).toBe(100);
		expect(body.error.spent_usd).toBe(150.5);
		expect(body.error.window).toBe("rolling_30d");
		expect(typeof body.error.resets_at).toBe("string");
		expect(new Date(body.error.resets_at as string).getTime()).toBe(
			oldest + 30 * 24 * 60 * 60 * 1000,
		);
	});

	it("refuses at exactly the limit", async () => {
		const ctx = makeContext([makeAccount()], { totalUsd: 100, oldestMs: null });
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100 }) },
		);
		expect(response.status).toBe(429);
	});

	it("sets Retry-After in seconds to the window end", async () => {
		const now = Date.now();
		// Relief in ~10 minutes: a rolling_7d window whose oldest counted
		// request is 7 days minus 10 minutes old.
		const oldest = now - (7 * 24 * 60 - 10) * 60 * 1000;
		const ctx = makeContext([makeAccount()], {
			totalUsd: 200,
			oldestMs: oldest,
		});

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100, limitWindow: "rolling_7d" }) },
		);

		const retryAfter = Number(response.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(500);
		expect(retryAfter).toBeLessThanOrEqual(600);
	});

	it("clamps Retry-After to an hour for a far-off window end", async () => {
		// Same clamp as model-capacity.ts's MAX_RETRY_AFTER_SECONDS: a calendar
		// month can be weeks away and "retry in 2419200 seconds" is not useful.
		const ctx = makeContext([makeAccount()], {
			totalUsd: 200,
			oldestMs: Date.now(),
		});

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100, limitWindow: "rolling_30d" }) },
		);

		expect(Number(response.headers.get("Retry-After"))).toBe(3600);
	});

	it("falls back to 60 seconds when the window end is unknown", async () => {
		// A rolling window with nothing counted has no known relief time. It
		// must not become 1 second (a retry storm) or be omitted.
		const ctx = makeContext([makeAccount()], { totalUsd: 200, oldestMs: null });

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100 }) },
		);

		expect(Number(response.headers.get("Retry-After"))).toBe(60);
		const body = (await response.json()) as { error: { resets_at: unknown } };
		expect(body.error.resets_at).toBeNull();
	});

	it("never reaches account selection", async () => {
		const ctx = makeContext([makeAccount()], { totalUsd: 200, oldestMs: null });

		await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1", "budgeted", {
			spendLimit: spendLimit({ limitUsd: 100 }),
		});

		const getAllAccounts = ctx.dbOps.getAllAccounts as unknown as {
			mock: { calls: unknown[] };
		};
		expect(getAllAccounts.mock.calls.length).toBe(0);
	});

	it("records the refusal through returnRefusal so it shows in fail rates", async () => {
		const ctx = makeContext([makeAccount()], { totalUsd: 200, oldestMs: null });

		await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1", "budgeted", {
			spendLimit: spendLimit({ limitUsd: 100 }),
		});

		expect(collectorStart.mock.calls.length).toBe(1);
		expect(collectorEnd.mock.calls.length).toBe(1);
		const start = collectorStart.mock.calls[0][0] as Record<string, unknown>;
		expect(start.apiKeyId).toBe("key-1");
		expect(start.accountId).toBeNull();
		const end = collectorEnd.mock.calls[0][0] as Record<string, unknown>;
		expect(end.success).toBe(false);
		expect(end.error).toBe("api_key_limit_exceeded");
	});

	it("runs the expensive rollup once, not once per request", async () => {
		const ctx = makeContext([makeAccount()], { totalUsd: 200, oldestMs: null });
		const options = { spendLimit: spendLimit({ limitUsd: 100 }) };

		for (let i = 0; i < 5; i++) {
			await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1", "b", options);
		}

		expect(ctx.spendQueries.count).toBe(1);
	});
});

describe("over the limit with enforce = warn", () => {
	it("does NOT refuse", async () => {
		const ctx = makeContext([], { totalUsd: 500, oldestMs: null });

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100, limitEnforce: "warn" }) },
		);

		expect(response.status).not.toBe(429);
		const body = (await response.json()) as { error?: { code?: string } };
		expect(body.error?.code).not.toBe("api_key_limit_exceeded");
	});

	it("still makes the overage visible by raising an alert event", async () => {
		const ctx = makeContext([], { totalUsd: 500, oldestMs: null });
		const seen: unknown[] = [];
		const listener = (event: unknown) => seen.push(event);
		spendLimitEvents.on("event", listener);

		try {
			await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1", "budgeted", {
				spendLimit: spendLimit({ limitUsd: 100, limitEnforce: "warn" }),
			});
		} finally {
			spendLimitEvents.off("event", listener);
		}

		expect(seen.length).toBe(1);
		expect(seen[0]).toMatchObject({
			apiKeyId: "key-1",
			apiKeyName: "budgeted",
			spentUsd: 500,
			limitUsd: 100,
			window: "rolling_30d",
		});
	});

	it("raises nothing while under the limit", async () => {
		const ctx = makeContext([], { totalUsd: 5, oldestMs: null });
		const seen: unknown[] = [];
		const listener = (event: unknown) => seen.push(event);
		spendLimitEvents.on("event", listener);

		try {
			await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1", "budgeted", {
				spendLimit: spendLimit({ limitUsd: 100, limitEnforce: "warn" }),
			});
		} finally {
			spendLimitEvents.off("event", listener);
		}

		expect(seen.length).toBe(0);
	});
});

describe("carve-outs", () => {
	it("exempts a verified internal probe", async () => {
		// A probe answered with a refusal counts as a refresh failure, and five
		// of those pause a healthy account.
		const ctx = makeContext([], { totalUsd: 999, oldestMs: null });

		const response = await handleProxy(
			makeRequest({
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-auto-refresh": "true",
			}),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 1 }) },
		);

		expect(response.status).not.toBe(429);
		// The exemption is decided before the counter is ever consulted.
		expect(ctx.spendQueries.count).toBe(0);
	});

	it("still enforces when the probe header carries the wrong secret", async () => {
		const ctx = makeContext([makeAccount()], {
			totalUsd: 999,
			oldestMs: null,
		});

		const response = await handleProxy(
			makeRequest({
				[INTERNAL_PROBE_SECRET_HEADER]: "not-the-secret",
				"x-better-ccflare-auto-refresh": "true",
			}),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 1 }) },
		);

		expect(response.status).toBe(429);
	});

	it("is a no-op in zero-key mode — no key, no limit, no query", async () => {
		const ctx = makeContext([], { totalUsd: 999, oldestMs: null });

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			null,
			null,
		);

		expect(response.status).not.toBe(429);
		expect(ctx.spendQueries.count).toBe(0);
	});

	it("is a no-op for an authenticated key with no limit", async () => {
		const ctx = makeContext([], { totalUsd: 999, oldestMs: null });

		await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1", "plain", {
			spendLimit: null,
		});

		expect(ctx.spendQueries.count).toBe(0);
	});
});

describe("failure handling", () => {
	it("fails OPEN when the counter cannot read the database", async () => {
		// A budget control must not become a proxy-wide outage. Access control
		// (the restriction checks) fails closed; this deliberately does not.
		const ctx = makeContext([], { totalUsd: 0, oldestMs: null });
		(
			ctx.dbOps as unknown as {
				getApiKeySpendSince: () => Promise<never>;
			}
		).getApiKeySpendSince = () => Promise.reject(new Error("db down"));

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 1 }) },
		);

		expect(response.status).not.toBe(429);
	});
});

describe("web_search interception and the spend limit", () => {
	function withWebSearchProbe(ctx: ProxyContext) {
		const getWebSearchEnabled = mock(() => false);
		(ctx.config as unknown as Record<string, unknown>).getWebSearchEnabled =
			getWebSearchEnabled;
		return getWebSearchEnabled;
	}

	it("is skipped when a blocking limit is exceeded", async () => {
		const ctx = makeContext([makeAccount()], { totalUsd: 200, oldestMs: null });
		const getWebSearchEnabled = withWebSearchProbe(ctx);

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ spendLimit: spendLimit({ limitUsd: 100 }) },
		);

		expect(response.status).toBe(429);
		expect(getWebSearchEnabled.mock.calls.length).toBe(0);
	});

	it("still runs when the exceeded limit only warns", async () => {
		const ctx = makeContext([], { totalUsd: 200, oldestMs: null });
		const getWebSearchEnabled = withWebSearchProbe(ctx);

		await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1", "budgeted", {
			spendLimit: spendLimit({ limitUsd: 100, limitEnforce: "warn" }),
		});

		expect(getWebSearchEnabled.mock.calls.length).toBe(1);
	});
});

describe("multi-window row enforcement", () => {
	function row(overrides: Partial<ApiKeyLimit> = {}): ApiKeyLimit {
		return {
			id: "v2",
			apiKeyId: "key-1",
			scopeModel: null,
			window: "month",
			limitUsd: 5,
			enforce: "block",
			createdAt: 1,
			updatedAt: 1,
			...overrides,
		};
	}
	function v2Context(
		rows: ApiKeyLimit[],
		events: Array<{ timestamp: number; costUsd: number; model: string | null }>,
	) {
		const ctx = makeContext([]);
		Object.assign(ctx.dbOps, {
			getApiKeyLimits: mock(async () => rows),
			getApiKeySpendEventsSince: mock(async () => events),
		});
		return ctx;
	}
	it("names the first exceeded model scope and returns its calendar boundary without a one-hour clamp", async () => {
		const now = Date.now();
		const ctx = v2Context(
			[
				row({ limitUsd: 100 }),
				row({ id: "model", scopeModel: "opus", window: "day", limitUsd: 5 }),
			],
			[{ timestamp: now - 1, costUsd: 8, model: "claude-opus-4-5" }],
		);
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ limitWindowMode: "calendar" },
		);
		expect(response.status).toBe(429);
		const body = await response.json();
		expect(body.error.scope_model).toBe("opus");
		expect(body.error.window).toBe("day");
		expect(body.error.limit_usd).toBe(5);
		expect(body.error.spent_usd).toBeGreaterThanOrEqual(8);
		const retry = Number(response.headers.get("Retry-After"));
		expect(
			Math.abs(
				retry -
					Math.ceil((Date.parse(body.error.resets_at) - Date.now()) / 1000),
			),
		).toBeLessThanOrEqual(1);
	});
	it("uses the whole month Retry-After even when it exceeds one hour", async () => {
		const ctx = v2Context(
			[row()],
			[{ timestamp: Date.now() - 1, costUsd: 8, model: "opus" }],
		);
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ limitWindowMode: "calendar" },
		);
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(3600);
	});
	it("returns rolling relief only after enough spend ages out", async () => {
		const now = Date.now();
		const ctx = v2Context(
			[row({ window: "hour" })],
			[
				{ timestamp: now - 3_000_000, costUsd: 2, model: "opus" },
				{ timestamp: now - 2_000_000, costUsd: 4, model: "opus" },
				{ timestamp: now - 1_000_000, costUsd: 3, model: "opus" },
			],
		);
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ limitWindowMode: "rolling" },
		);
		expect(response.status).toBe(429);
		expect(
			Math.abs(Number(response.headers.get("Retry-After")) - 1600),
		).toBeLessThanOrEqual(1);
	});
	it("does not apply a different model scope", async () => {
		const ctx = v2Context(
			[row({ scopeModel: "sonnet" })],
			[{ timestamp: Date.now() - 1, costUsd: 8, model: "sonnet" }],
		);
		expect(
			(await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1")).status,
		).not.toBe(429);
	});
	it("allows requests when a row counter check fails", async () => {
		const ctx = v2Context([row()], []);
		Object.assign(ctx.dbOps, {
			getApiKeySpendEventsSince: mock(async () => {
				throw new Error("db unavailable");
			}),
		});
		expect(
			(await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1")).status,
		).not.toBe(429);
	});
	it("warns for an exceeded model row while allowing the request", async () => {
		const listener = mock((_event: { window: string }) => {});
		spendLimitEvents.on("event", listener);
		try {
			const ctx = v2Context(
				[row({ scopeModel: "opus", enforce: "warn" })],
				[{ timestamp: Date.now() - 1, costUsd: 8, model: "opus" }],
			);
			expect(
				(await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1")).status,
			).not.toBe(429);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener.mock.calls[0][0].window).toContain("opus");
		} finally {
			spendLimitEvents.off("event", listener);
		}
	});
});

describe("review regressions: requested/routed scopes and relief", () => {
	const row = (extra: Partial<ApiKeyLimit> = {}): ApiKeyLimit => ({
		id: "limit-review",
		apiKeyId: "key-1",
		scopeModel: null,
		window: "hour",
		limitUsd: 5,
		enforce: "block",
		createdAt: 0,
		updatedAt: 0,
		...extra,
	});
	function context(rows: ApiKeyLimit[], model: string) {
		const ctx = makeContext([]);
		Object.assign(ctx.dbOps, {
			getApiKeyLimits: mock(async () => rows),
			getApiKeySpendEventsSince: mock(async () => [
				{ requestId: "spent", timestamp: Date.now() - 1, costUsd: 8, model },
			]),
		});
		return ctx;
	}
	it("enforces the trusted original Responses GPT model scope after translation", async () => {
		const ctx = context([row({ scopeModel: "gpt-5.4" })], "gpt-5.4");
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{
				trustedNativeResponses: true,
				trustedRequestedModel: "gpt-5.4",
				limitWindowMode: "calendar",
			} as Parameters<typeof handleProxy>[5],
		);
		expect(response.status).toBe(429);
	});
	it("uses the latest relief time when hourly and monthly rows both block", async () => {
		const ctx = context([row(), row({ id: "month", window: "month" })], "opus");
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ limitWindowMode: "calendar" },
		);
		expect(response.status).toBe(429);
		const body = await response.json();
		const reset = new Date();
		reset.setUTCDate(1);
		reset.setUTCMonth(reset.getUTCMonth() + 1);
		reset.setUTCHours(0, 0, 0, 0);
		expect(body.error.resets_at).toBe(reset.toISOString());
		expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(3600);
	});
	it("blocks a sonnet request before forwarding when a combo routes it to exhausted opus", async () => {
		const ctx = context([row({ scopeModel: "opus" })], "claude-opus-4-5");
		const account = makeAccount();
		Object.assign(ctx.dbOps, {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => ({
				id: "combo",
				name: "combo",
				enabled: true,
				slots: [
					{
						id: "slot",
						combo_id: "combo",
						account_id: account.id,
						sort_order: 0,
						model: "claude-opus-4-5",
						model_override: "claude-opus-4-5",
						enabled: true,
					},
				],
			})),
		});
		const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("must not forward"),
		);
		const req = new Request(PROXY_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		});
		const response = await handleProxy(
			req,
			PROXY_URL,
			ctx,
			"key-1",
			"budgeted",
			{ limitWindowMode: "calendar" },
		);
		expect(response.status).toBe(429);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	it("fails closed when the first multi-window spend query times out", async () => {
		const ctx = context([row()], "opus");
		Object.assign(ctx.dbOps, {
			getApiKeySpendEventsSince: mock(async () => {
				throw new Error("PG timeout");
			}),
		});
		const response = await handleProxy(makeRequest(), PROXY_URL, ctx, "key-1");
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body.error.code).toBe("api_key_limit_check_unavailable");
	});
});

describe("request reservation lifecycle", () => {
	const row: ApiKeyLimit = {
		id: "inflight",
		apiKeyId: "key-1",
		scopeModel: null,
		window: "hour",
		limitUsd: 5,
		enforce: "block",
		createdAt: 0,
		updatedAt: 0,
	};
	function context() {
		const ctx = makeContext([
			makeAccount({
				provider: "test" as Account["provider"],
				expires_at: Date.now() + 3_600_000,
			}),
		]);
		Object.assign(ctx.provider, {
			name: "test",
			buildUrl: () => "https://upstream.example/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false }),
			isStreamingResponse: (response: Response) =>
				response.headers.get("content-type")?.includes("event-stream") ?? false,
		});
		Object.assign(ctx.config, { getStorePayloads: () => false });
		Object.assign(ctx.dbOps, {
			getApiKeyLimits: mock(async () => [row]),
			getApiKeySpendEventsSince: mock(async () => [
				{
					requestId: "history",
					timestamp: Date.now() - 1000,
					costUsd: 4.9,
					model: "claude-opus-4-5",
				},
			]),
		});
		return ctx;
	}
	function request(signal?: AbortSignal) {
		return new Request(PROXY_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 2048,
			}),
			signal,
		});
	}
	it("admits one of two parallel requests near a limit and releases a cancelled stream", async () => {
		const ctx = context();
		const forward = spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode("data: open\n\n"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const responses = await Promise.all([
			handleProxy(request(), PROXY_URL, ctx, "key-1"),
			handleProxy(request(), PROXY_URL, ctx, "key-1"),
		]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
		expect(forward).toHaveBeenCalledTimes(1);
		await responses.find((r) => r.status === 200)?.body?.cancel();
		expect(
			(
				await getApiKeySpendCounter(ctx.dbOps).getLimitSnapshot(
					"key-1",
					row,
					"calendar",
				)
			).spentUsd,
		).toBe(4.9);
	});
	it("keeps the reservation after response EOF until detached usage pricing settles", async () => {
		const ctx = context();
		let price!: (cost: number) => void;
		spyOn(core, "estimateCostUSD").mockImplementation(
			() =>
				new Promise((resolve) => {
					price = resolve;
				}),
		);
		const collector = new usageCollectorModule.UsageCollector(
			ctx.dbOps,
			{
				enqueue: () => {},
				canAcceptPayload: () => false,
				recordPayloadDrop: () => {},
				dispose: async () => {},
			} as never,
			() => false,
			() => {},
		);
		const ending = spyOn(collector, "handleEnd");
		spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(collector);
		spyOn(usageCollectorModule, "tryGetUsageCollector").mockReturnValue(
			collector,
		);
		const stream = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","type":"message","role":"assistant","model":"claude-opus-4-5","usage":{"input_tokens":100,"output_tokens":0},"content":[]}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");
		spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(stream, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		try {
			const response = await handleProxy(request(), PROXY_URL, ctx, "key-1");
			await response.text();
			await Promise.resolve();
			await Promise.resolve();
			const before = await getApiKeySpendCounter(ctx.dbOps).getLimitSnapshot(
				"key-1",
				row,
				"calendar",
			);
			expect(before.spentUsd).toBeGreaterThan(4.9);
			expect(typeof price).toBe("function");
			price(0.02);
			await ending.mock.results[0].value;
			expect(
				(
					await getApiKeySpendCounter(ctx.dbOps).getLimitSnapshot(
						"key-1",
						row,
						"calendar",
					)
				).spentUsd,
			).toBeCloseTo(4.92, 6);
		} finally {
			collector.dispose();
		}
	});
	it("releases a validation failure before its response body is consumed", async () => {
		const ctx = context();
		const invalid = new Request(PROXY_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-opus-4-5", max_tokens: 2048 }),
		});
		const response = await handleProxy(invalid, PROXY_URL, ctx, "key-1");
		try {
			expect(response.status).toBe(400);
			expect(response.bodyUsed).toBe(false);
			expect(
				(
					await getApiKeySpendCounter(ctx.dbOps).getLimitSnapshot(
						"key-1",
						row,
						"calendar",
					)
				).spentUsd,
			).toBe(4.9);
		} finally {
			await response.body?.cancel();
		}
	});
	it("releases the reservation when forwarding throws", async () => {
		const ctx = context();
		spyOn(globalThis, "fetch").mockRejectedValue(new Error("forward failed"));
		await expect(
			handleProxy(request(), PROXY_URL, ctx, "key-1"),
		).rejects.toThrow("All accounts failed");
		expect(
			(
				await getApiKeySpendCounter(ctx.dbOps).getLimitSnapshot(
					"key-1",
					row,
					"calendar",
				)
			).spentUsd,
		).toBe(4.9);
	});
	it("releases an open stream's reservation immediately on client abort", async () => {
		const ctx = context();
		const abort = new AbortController();
		spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode("data: open\n\n"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const response = await handleProxy(
			request(abort.signal),
			PROXY_URL,
			ctx,
			"key-1",
		);
		expect(response.status).toBe(200);
		abort.abort();
		expect(
			(
				await getApiKeySpendCounter(ctx.dbOps).getLimitSnapshot(
					"key-1",
					row,
					"calendar",
				)
			).spentUsd,
		).toBe(4.9);
		await response.body?.cancel();
	});
});
