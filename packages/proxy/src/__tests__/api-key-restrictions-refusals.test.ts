/**
 * The two refusals per-API-key restrictions produce, at the handleProxy level.
 *
 * Both are decided before any upstream is contacted, both are 403, and both
 * carry an Anthropic-compatible envelope because they go straight back to
 * Claude Code clients:
 *
 *   api_key_model_restricted    the client asked for a model this key may not use
 *   api_key_account_restricted  the key's account/provider allowlist emptied the pool
 *
 * The second one exists specifically so it does NOT fall through to the generic
 * pool_exhausted 503: that answer means "no capacity right now" and invites a
 * retry, and no amount of waiting changes a policy decision.
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
import { usageCache } from "@better-ccflare/providers";
import type { Account, ApiKeyRestrictions } from "@better-ccflare/types";
import { transformRequestBodyModel } from "../../../providers/src/utils/model-mapping";
import type { ProxyContext } from "../handlers";
import * as handlersModule from "../handlers";
import {
	getApiKeySpendCounter,
	resetApiKeySpendCounter,
} from "../handlers/api-key-spend";
import { INTERNAL_PROBE_SECRET_HEADER } from "../handlers/proxy-types";
import * as modelCatalogModule from "../model-catalog";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

const SECRET = "probe-secret-for-refusal-tests";

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

function makeContext(accounts: Account[]): ProxyContext {
	return {
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
	};
}

function makeRequest(
	model = "claude-opus-4-5",
	headers: Record<string, string> = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function restrictions(
	overrides: Partial<ApiKeyRestrictions> = {},
): ApiKeyRestrictions {
	return {
		allowedAccounts: null,
		allowedModels: null,
		allowedProviders: null,
		...overrides,
	};
}

const PROXY_URL = new URL("https://proxy.local/v1/messages");

let savedPassthrough: string | undefined;

beforeEach(() => {
	savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	usageCache.clear();
	stubUsageCollector();
});

afterEach(() => {
	mock.restore();
	usageCache.clear();
	if (savedPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
	}
});

// ── Seam 5: the model allowlist ───────────────────────────────────────────────

describe("api_key_model_restricted", () => {
	it("refuses a model outside the allowlist with a 403 permission_error", async () => {
		const ctx = makeContext([makeAccount()]);

		const response = await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
			"key-1",
			"scoped-key",
			{ restrictions: restrictions({ allowedModels: ["haiku"] }) },
		);

		expect(response.status).toBe(403);
		const body = (await response.json()) as {
			type: string;
			error: Record<string, unknown>;
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("permission_error");
		expect(body.error.code).toBe("api_key_model_restricted");
		expect(String(body.error.message)).toContain("claude-opus-4-5");
	});

	it("rechecks a client-selected agent preference before account selection", async () => {
		const ctx = makeContext([makeAccount()]);
		Object.assign(ctx.dbOps, {
			getAgentPreference: mock(async () => ({ model: "claude-opus-4-5" })),
		});
		spyOn(modelCatalogModule, "getModelCatalog").mockResolvedValue({
			models: [],
			fetchedAt: Date.now(),
			source: "fallback",
		});
		const response = await handleProxy(
			makeRequest("claude-haiku-4-5", {
				"x-better-ccflare-agent-id": "agent-1",
			}),
			PROXY_URL,
			ctx,
			"key-1",
			"scoped-key",
			{ restrictions: restrictions({ allowedModels: ["haiku"] }) },
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe("api_key_model_restricted");
		expect(ctx.dbOps.getAllAccounts).not.toHaveBeenCalled();
	});

	it("rechecks a combo slot model pin even when cost tracking is disabled", async () => {
		const ctx = makeContext([makeAccount()]);
		Object.assign(ctx.config, { getCostTrackingEnabled: () => false });
		Object.assign(ctx.dbOps, {
			getActiveComboForFamily: mock(async () => ({
				id: "combo-1",
				name: "pinned",
				enabled: true,
				slots: [
					{
						id: "slot-1",
						account_id: "acc-1",
						model: "claude-opus-4-5",
						enabled: true,
						priority: 0,
					},
				],
			})),
		});
		const response = await handleProxy(
			makeRequest("claude-haiku-4-5"),
			PROXY_URL,
			ctx,
			"key-1",
			"scoped-key",
			{ restrictions: restrictions({ allowedModels: ["haiku"] }) },
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe("api_key_model_restricted");
	});

	it("compares and records the plain model before its provider-routing suffix", async () => {
		const ctx = makeContext([makeAccount()]);
		const proxy = spyOn(handlersModule, "proxyWithAccount").mockResolvedValue(
			new Response("ok"),
		);
		const response = await handleProxy(
			makeRequest('claude-opus-4-5 {"only":["example"]}'),
			PROXY_URL,
			ctx,
			"key-1",
			"scoped-key",
			{ restrictions: restrictions({ allowedModels: ["claude-opus-4-5"] }) },
		);
		expect(response.status).toBe(200);
		expect(proxy.mock.calls[0][3].limitModel).toBe("claude-opus-4-5");
	});

	it("allows provider-native account mappings and still checks their spend", async () => {
		const account = makeAccount({
			provider: "stub-account-model-mapping",
			api_key: "test-key",
			refresh_token: "",
			model_mappings: JSON.stringify({ opus: "gpt-native" }),
		});
		const ctx = makeContext([account]);
		Object.assign(ctx.dbOps, {
			getApiKeyLimits: async () => [
				{
					id: "limit",
					apiKeyId: "key-1",
					scopeModel: null,
					window: "day",
					limitUsd: 100,
					enforce: "block",
					createdAt: 0,
					updatedAt: 0,
				},
			],
			getApiKeySpendEventsSince: async () => [],
			updateAccountUsage: async () => {},
		});
		Object.assign(ctx.provider, {
			name: account.provider,
			buildUrl: () => "https://upstream.invalid/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: transformRequestBodyModel,
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, statusHeader: "allowed" }),
			isStreamingResponse: () => false,
		});
		Object.assign(ctx.config, { getStorePayloads: () => false });
		const originalFetch = globalThis.fetch;
		const upstream = mock(async (input: RequestInfo | URL) => {
			const sent = input as Request;
			const body = JSON.parse(await sent.text());
			expect(body.model).toBe("gpt-native");
			return new Response(
				JSON.stringify({
					id: "msg-mapped",
					type: "message",
					role: "assistant",
					model: body.model,
					content: [{ type: "text", text: "ok" }],
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		});
		globalThis.fetch = upstream as typeof fetch;
		spyOn(core, "getModelRates").mockResolvedValue(null);
		resetApiKeySpendCounter();
		const spendCheck = spyOn(
			getApiKeySpendCounter(ctx.dbOps),
			"checkAndReserve",
		);
		try {
			const response = await handleProxy(
				makeRequest(),
				PROXY_URL,
				ctx,
				"key-1",
				"scoped-key",
				{ restrictions: restrictions({ allowedModels: ["opus"] }) },
			);
			expect(response.status).toBe(200);
			expect(upstream).toHaveBeenCalledTimes(1);
			expect(
				spendCheck.mock.calls.some((call) => call[5] === "gpt-native"),
			).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
			resetApiKeySpendCounter();
		}
	});

	it("never reaches account selection", async () => {
		const accounts = [makeAccount()];
		const ctx = makeContext(accounts);

		await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
			null,
			null,
			{ restrictions: restrictions({ allowedModels: [] }) },
		);

		// Nothing upstream, and not even a candidate pool read: the refusal is
		// decided from the request body alone.
		const getAllAccounts = ctx.dbOps.getAllAccounts as unknown as {
			mock: { calls: unknown[] };
		};
		expect(getAllAccounts.mock.calls.length).toBe(0);
	});

	it("records the refusal so it shows in the dashboard fail-rate", async () => {
		const ctx = makeContext([makeAccount()]);

		await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
			null,
			null,
			{
				restrictions: restrictions({ allowedModels: ["haiku"] }),
			},
		);

		expect(collectorStart.mock.calls.length).toBe(1);
		expect(collectorEnd.mock.calls.length).toBe(1);
		const end = collectorEnd.mock.calls[0][0] as Record<string, unknown>;
		expect(end.success).toBe(false);
		expect(end.error).toBe("api_key_model_restricted");
	});

	it("allows a model matched by its family name", async () => {
		const ctx = makeContext([]);

		const response = await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
			null,
			null,
			{ restrictions: restrictions({ allowedModels: ["opus"] }) },
		);

		// Not refused for the model. With no accounts configured it falls
		// through to the ordinary empty-pool answer.
		expect(response.status).not.toBe(403);
	});

	it("allows a model listed by its exact id", async () => {
		const ctx = makeContext([]);

		const response = await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
			null,
			null,
			{ restrictions: restrictions({ allowedModels: ["claude-opus-4-5"] }) },
		);

		expect(response.status).not.toBe(403);
	});

	it("exempts a verified internal probe", async () => {
		const ctx = makeContext([]);

		const response = await handleProxy(
			makeRequest("claude-opus-4-5", {
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-auto-refresh": "true",
			}),
			PROXY_URL,
			ctx,
			null,
			null,
			{ restrictions: restrictions({ allowedModels: [] }) },
		);

		// A probe answered with a refusal counts as a refresh failure, and five
		// of those pause a perfectly healthy account.
		expect(response.status).not.toBe(403);
	});

	it("is a no-op when no restrictions are supplied (zero-keys mode)", async () => {
		const ctx = makeContext([]);

		const response = await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
		);

		expect(response.status).not.toBe(403);
	});
});

// ── The account/provider refusal ──────────────────────────────────────────────

describe("api_key_account_restricted", () => {
	it("answers 403 rather than the generic pool_exhausted 503", async () => {
		const ctx = makeContext([makeAccount({ id: "acc-1" })]);

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			"key-1",
			"scoped-key",
			{ restrictions: restrictions({ allowedAccounts: ["acc-other"] }) },
		);

		expect(response.status).toBe(403);
		const body = (await response.json()) as {
			error: Record<string, unknown>;
		};
		expect(body.error.type).toBe("permission_error");
		expect(body.error.code).toBe("api_key_account_restricted");
		expect(body.error.restricted_by).toBe("accounts");
		// No retry advice: waiting cannot change a policy decision.
		expect(response.headers.get("Retry-After")).toBeNull();
	});

	it("names the provider allowlist when that is what emptied the pool", async () => {
		const ctx = makeContext([makeAccount({ provider: "anthropic" })]);

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			null,
			null,
			{
				restrictions: restrictions({ allowedProviders: ["zai"] }),
			},
		);

		expect(response.status).toBe(403);
		const body = (await response.json()) as {
			error: Record<string, unknown>;
		};
		expect(body.error.restricted_by).toBe("providers");
	});

	it("answers 403 when the forced-account header names a disallowed account", async () => {
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "allowed" }),
			makeAccount({ id: "acc-2", name: "forbidden" }),
		]);

		const response = await handleProxy(
			makeRequest("claude-opus-4-5", {
				"x-better-ccflare-account-id": "acc-2",
			}),
			PROXY_URL,
			ctx,
			null,
			null,
			{ restrictions: restrictions({ allowedAccounts: ["acc-1"] }) },
		);

		expect(response.status).toBe(403);
		const body = (await response.json()) as {
			error: Record<string, unknown>;
		};
		expect(body.error.code).toBe("api_key_account_restricted");
		expect(body.error.restricted_by).toBe("forced account");
		expect(JSON.stringify(body)).not.toContain("forbidden");
	});

	it("answers a restriction-empty combo with 403 when session fallback is disabled", async () => {
		const ctx = makeContext([makeAccount()]);
		Object.assign(ctx.config, { getComboSessionFallback: () => false });
		Object.assign(ctx.dbOps, {
			getActiveComboForFamily: mock(async () => ({
				id: "combo-1",
				name: "restricted combo",
				enabled: true,
				slots: [
					{
						id: "slot-1",
						account_id: "acc-1",
						model: "",
						enabled: true,
						priority: 0,
					},
				],
			})),
		});
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			null,
			null,
			{
				restrictions: restrictions({ allowedAccounts: [] }),
			},
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe(
			"api_key_account_restricted",
		);
		expect(response.headers.get("Retry-After")).toBeNull();
	});

	it("excludes restricted-away account names and recovery times from pool exhaustion", async () => {
		const now = Date.now();
		const ctx = makeContext([
			makeAccount({
				id: "allowed",
				name: "allowed",
				rate_limited_until: now + 300_000,
			}),
			makeAccount({
				id: "private",
				name: "private-account-name",
				rate_limited_until: now + 30_000,
			}),
		]);
		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			null,
			null,
			{
				restrictions: restrictions({ allowedAccounts: ["allowed"] }),
			},
		);
		expect(response.status).toBe(503);
		expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(
			299,
		);
		const body = await response.text();
		expect(body).toContain("allowed");
		expect(body).not.toContain("private-account-name");
		expect(body).not.toContain(new Date(now + 30_000).toISOString());
	});

	it("records the refusal", async () => {
		const ctx = makeContext([makeAccount({ id: "acc-1" })]);

		await handleProxy(makeRequest(), PROXY_URL, ctx, null, null, {
			restrictions: restrictions({ allowedAccounts: [] }),
		});

		const end = collectorEnd.mock.calls[0][0] as Record<string, unknown>;
		expect(end.error).toBe("api_key_account_restricted");
	});

	it("still answers pool_exhausted when the pool was empty for capacity reasons", async () => {
		// The restriction narrowed nothing — there was nothing to narrow. That
		// must keep reading as capacity, with its Retry-After intact.
		const ctx = makeContext([]);

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			null,
			null,
			{
				restrictions: restrictions({ allowedAccounts: ["acc-1"] }),
			},
		);

		expect(response.status).toBe(503);
		const body = (await response.json()) as {
			error: Record<string, unknown>;
		};
		expect(body.error.code).not.toBe("api_key_account_restricted");
	});

	it("leaves an unrestricted key on exactly the old path", async () => {
		const ctx = makeContext([]);

		const response = await handleProxy(
			makeRequest(),
			PROXY_URL,
			ctx,
			null,
			null,
			{
				restrictions: null,
			},
		);

		expect(response.status).toBe(503);
	});
});

// ── Local web_search interception ─────────────────────────────────────────────

describe("web_search interception and the model allowlist", () => {
	function withWebSearchProbe(ctx: ProxyContext) {
		const getWebSearchEnabled = mock(() => false);
		(ctx.config as unknown as Record<string, unknown>).getWebSearchEnabled =
			getWebSearchEnabled;
		return getWebSearchEnabled;
	}

	it("is skipped for a request the key is about to be refused for", async () => {
		const ctx = makeContext([makeAccount()]);
		const getWebSearchEnabled = withWebSearchProbe(ctx);

		const response = await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
			"key-1",
			"scoped-key",
			{ restrictions: restrictions({ allowedModels: ["haiku"] }) },
		);

		// The local search path would otherwise answer (and spend search
		// provider quota on) a request this key may not make.
		expect(response.status).toBe(403);
		expect(getWebSearchEnabled.mock.calls.length).toBe(0);
	});

	it("still runs for a permitted model", async () => {
		const ctx = makeContext([]);
		const getWebSearchEnabled = withWebSearchProbe(ctx);

		await handleProxy(
			makeRequest("claude-opus-4-5"),
			PROXY_URL,
			ctx,
			"key-1",
			"scoped-key",
			{ restrictions: restrictions({ allowedModels: ["opus"] }) },
		);

		expect(getWebSearchEnabled.mock.calls.length).toBe(1);
	});
});
