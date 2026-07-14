import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers/proxy-types";
import {
	fetchLiveModels,
	getModelCatalog,
	ingestModelsListing,
	initModelCatalogRefresh,
	type ModelCatalog,
	refreshModelCatalog,
	resetModelCatalogForTest,
} from "../model-catalog";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-console-account",
		// Console (API-key) accounts are the default-eligible provider for
		// automatic catalog refreshes; override to "anthropic" for OAuth tests.
		provider: "claude-console-api",
		api_key: "sk-test-key",
		refresh_token: "rt",
		access_token: "at-valid",
		expires_at: Date.now() + 60 * 60 * 1000,
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
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeCtx(
	accounts: Account[],
	options?: { oauthRefreshEnabled?: boolean },
): ProxyContext {
	const oauthRefreshEnabled = options?.oauthRefreshEnabled ?? false;
	return {
		strategy: {} as never,
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		dbOps: { getAllAccounts: async () => accounts } as any,
		runtime: { port: 8080, clientId: "test-client" } as never,
		config: {
			getModelCatalogOAuthRefreshEnabled: () => oauthRefreshEnabled,
		} as never,
		// biome-ignore lint/style/noNonNullAssertion: anthropic provider is always registered in this test environment
		provider: getProvider("anthropic")!,
		refreshInFlight: new Map(),
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		asyncWriter: { enqueue: (fn: () => unknown) => fn() } as any,
	};
}

const TEST_CACHE_DIR = join(tmpdir(), "better-ccflare-test-model-catalog");

async function cleanCacheDir() {
	await fs.rm(TEST_CACHE_DIR, { recursive: true, force: true });
}

async function writeCacheFile(catalog: ModelCatalog): Promise<void> {
	await fs.mkdir(TEST_CACHE_DIR, { recursive: true });
	await fs.writeFile(
		join(TEST_CACHE_DIR, "anthropic-models.json"),
		JSON.stringify(catalog, null, 2),
	);
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("model-catalog", () => {
	const originalFetch = global.fetch;

	beforeEach(async () => {
		process.env.BETTER_CCFLARE_MODELS_CACHE_DIR = TEST_CACHE_DIR;
		delete process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS;
		delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
		await cleanCacheDir();
		resetModelCatalogForTest();
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		delete process.env.BETTER_CCFLARE_MODELS_CACHE_DIR;
		delete process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS;
		delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
		await cleanCacheDir();
		resetModelCatalogForTest();
	});

	describe("fetchLiveModels", () => {
		it("selects an active console account and fetches models", async () => {
			global.fetch = mock(async (input: RequestInfo | URL) => {
				const url = input instanceof Request ? input.url : String(input);
				expect(url).toContain("/v1/models");
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-sonnet-5",
								display_name: "Claude Sonnet 5",
								created_at: "2026-01-01T00:00:00Z",
							},
						],
						has_more: false,
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const models = await fetchLiveModels(ctx);

			expect(models).toEqual([
				{
					id: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					createdAt: "2026-01-01T00:00:00Z",
				},
			]);
		});

		it("skips paused accounts and accounts of other providers", async () => {
			let calledUrl: string | undefined;
			global.fetch = mock(async (input: RequestInfo | URL) => {
				calledUrl = input instanceof Request ? input.url : String(input);
				return new Response(JSON.stringify({ data: [], has_more: false }), {
					status: 200,
				});
			}) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({ id: "paused", paused: true, priority: -1 }),
				makeAccount({ id: "other-provider", provider: "zai", priority: -1 }),
				makeAccount({ id: "eligible", priority: 5 }),
			]);
			await fetchLiveModels(ctx);

			expect(calledUrl).toContain("/v1/models");
		});

		it("prefers the account with the lowest priority number", async () => {
			const usedAccountIds: string[] = [];
			global.fetch = mock(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					const headers = new Headers(init?.headers);
					usedAccountIds.push(headers.get("authorization") ?? "");
					return new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					});
				},
			) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({ id: "low-prio", priority: 10, api_key: "sk-low" }),
				makeAccount({ id: "high-prio", priority: 0, api_key: "sk-high" }),
			]);
			await fetchLiveModels(ctx);

			expect(usedAccountIds[0]).toBe("Bearer sk-high");
		});

		it("paginates using after_id until has_more is false", async () => {
			const seenAfterIds: (string | null)[] = [];
			global.fetch = mock(async (input: RequestInfo | URL) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				seenAfterIds.push(url.searchParams.get("after_id"));
				if (!url.searchParams.has("after_id")) {
					return new Response(
						JSON.stringify({
							data: [{ id: "model-a", display_name: "Model A" }],
							has_more: true,
							last_id: "model-a",
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						data: [{ id: "model-b", display_name: "Model B" }],
						has_more: false,
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const models = await fetchLiveModels(ctx);

			expect(models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
			expect(seenAfterIds).toEqual([null, "model-a"]);
		});

		it("stops after a defensive maximum of 5 pages", async () => {
			let callCount = 0;
			global.fetch = mock(async () => {
				callCount++;
				return new Response(
					JSON.stringify({
						data: [
							{ id: `model-${callCount}`, display_name: `Model ${callCount}` },
						],
						has_more: true,
						last_id: `model-${callCount}`,
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const models = await fetchLiveModels(ctx);

			expect(callCount).toBe(5);
			expect(models).toHaveLength(5);
		});

		it("throws when no eligible anthropic account exists", async () => {
			const ctx = makeCtx([
				makeAccount({ provider: "zai" }),
				makeAccount({ paused: true }),
			]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/no active anthropic account/i,
			);
		});

		it("skips accounts with a custom_endpoint override", async () => {
			let calledUrl: string | undefined;
			global.fetch = mock(async (input: RequestInfo | URL) => {
				calledUrl = input instanceof Request ? input.url : String(input);
				return new Response(JSON.stringify({ data: [], has_more: false }), {
					status: 200,
				});
			}) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({
					id: "custom-endpoint",
					custom_endpoint: "https://compatible.example.com",
					priority: -1,
				}),
				makeAccount({ id: "eligible", priority: 5 }),
			]);
			await fetchLiveModels(ctx);

			expect(calledUrl).toContain("/v1/models");
		});

		it("throws when only accounts with a custom_endpoint override exist", async () => {
			const ctx = makeCtx([
				makeAccount({ custom_endpoint: "https://compatible.example.com" }),
			]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/no active anthropic account/i,
			);
		});

		it("throws when the upstream returns a non-ok response", async () => {
			global.fetch = mock(
				async () => new Response("boom", { status: 500 }),
			) as unknown as typeof fetch;
			const ctx = makeCtx([makeAccount()]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(/500/);
		});

		it("throws with OAuth-opt-in guidance when only an OAuth account exists and allowOAuth is not requested", async () => {
			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/no active anthropic account/i,
			);
			await expect(fetchLiveModels(ctx)).rejects.toThrow(
				/BETTER_CCFLARE_MODELS_OAUTH_REFRESH/,
			);
		});

		it("allows an OAuth account when allowOAuth is explicitly requested", async () => {
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			await expect(fetchLiveModels(ctx, { allowOAuth: true })).resolves.toEqual(
				[],
			);
		});

		it("prefers a console account over an OAuth account even when allowOAuth is requested", async () => {
			const usedAccountIds: string[] = [];
			global.fetch = mock(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					const headers = new Headers(init?.headers);
					usedAccountIds.push(headers.get("authorization") ?? "");
					return new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					});
				},
			) as unknown as typeof fetch;

			const ctx = makeCtx([
				makeAccount({
					id: "oauth-high-prio",
					provider: "anthropic",
					priority: 0,
					access_token: "at-oauth",
				}),
				makeAccount({
					id: "console-low-prio",
					provider: "claude-console-api",
					priority: 10,
					api_key: "sk-console",
				}),
			]);
			await fetchLiveModels(ctx, { allowOAuth: true });

			expect(usedAccountIds[0]).toBe("Bearer sk-console");
		});
	});

	describe("refreshModelCatalog / getModelCatalog", () => {
		it("returns source 'fallback' with no cache and no accounts", async () => {
			const ctx = makeCtx([]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.length).toBeGreaterThan(0);
		});

		it("stores a live catalog after a successful refresh", async () => {
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(true);
			expect(result.catalog.nextRefreshAt).toBeGreaterThan(
				result.catalog.fetchedAt,
			);
			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models).toEqual([
				{
					id: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					createdAt: null,
				},
			]);
		});

		it("keeps the old cache when a later refresh fails (fail-open)", async () => {
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			) as unknown as typeof fetch;
			const ctx = makeCtx([makeAccount()]);
			await refreshModelCatalog(ctx);

			global.fetch = mock(
				async () => new Response("boom", { status: 500 }),
			) as unknown as typeof fetch;
			const failedResult = await refreshModelCatalog(ctx);

			expect(failedResult.success).toBe(false);
			expect(failedResult.error).toBeTruthy();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models[0]?.id).toBe("claude-sonnet-5");
		});

		it("treats BETTER_CCFLARE_MODELS_OFFLINE=1 as a no-op refresh", async () => {
			process.env.BETTER_CCFLARE_MODELS_OFFLINE = "1";
			const fetchMock = mock(async () => new Response("{}", { status: 200 }));
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("persists the catalog to disk and reloads it in a fresh store instance", async () => {
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			) as unknown as typeof fetch;
			const ctx = makeCtx([makeAccount()]);
			await refreshModelCatalog(ctx);

			// Simulate a process restart: drop the in-memory singleton, keep the file.
			resetModelCatalogForTest();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models[0]?.id).toBe("claude-sonnet-5");
		});

		it("fails an automatic-trigger refresh against an OAuth-only account when the opt-in is not set", async () => {
			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			const result = await refreshModelCatalog(ctx, { trigger: "automatic" });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/BETTER_CCFLARE_MODELS_OAUTH_REFRESH/);
		});

		it("succeeds an automatic-trigger refresh against an OAuth-only account once the opt-in is enabled", async () => {
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount({ provider: "anthropic" })], {
				oauthRefreshEnabled: true,
			});
			const result = await refreshModelCatalog(ctx, { trigger: "automatic" });

			expect(result.success).toBe(true);
		});

		it("always succeeds a manual-trigger refresh against an OAuth-only account, opt-in or not", async () => {
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount({ provider: "anthropic" })]);
			const result = await refreshModelCatalog(ctx, { trigger: "manual" });

			expect(result.success).toBe(true);
		});

		it("persists nextRefreshAt computed from the configured refresh interval", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "2";
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const result = await refreshModelCatalog(ctx);

			expect(result.success).toBe(true);
			const twoHoursMs = 2 * 60 * 60 * 1000;
			const oneDayMs = 24 * 60 * 60 * 1000;
			expect(result.catalog.nextRefreshAt).toBeGreaterThanOrEqual(
				result.catalog.fetchedAt + twoHoursMs,
			);
			expect(result.catalog.nextRefreshAt).toBeLessThanOrEqual(
				result.catalog.fetchedAt + twoHoursMs + oneDayMs,
			);
		});
	});

	describe("initModelCatalogRefresh", () => {
		it("disables the scheduler entirely when refresh hours is 0 (no fetch, inert unregister)", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0";
			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).not.toHaveBeenCalled();
			expect(typeof unregister).toBe("function");
		});

		it("fires the initial refresh once the freshly-derived due time has already passed", async () => {
			// A tiny refresh interval makes the freshly-derived due time
			// (fetchedAt-of-the-fallback-catalog + interval + jitter) due almost
			// immediately, without needing to seed a disk cache.
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";
			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, { initialDelayMs: 5 });
			await new Promise((resolve) => setTimeout(resolve, 30));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
			expect((await getModelCatalog()).source).toBe("live");
		});

		it("does not fire before the freshly-derived due time (persisted recent fetchedAt, default interval)", async () => {
			// Default 168h interval: seed a disk cache with fetchedAt "now" so
			// the derived due time is deterministically far in the future.
			// (Deliberately not relying on the bundled fallback catalog here —
			// since Part D, its fetchedAt is the fixed BUNDLED_MODELS_AS_OF
			// snapshot date rather than "now", which may itself already be more
			// than 168h in the past.)
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now(),
				source: "live",
			});
			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			await new Promise((resolve) => setTimeout(resolve, 60));
			unregister();

			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("resumes a refresh from a persisted nextRefreshAt that has already passed", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "168";
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now() - 1000,
				source: "live",
				nextRefreshAt: Date.now() - 500,
			});

			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, { initialDelayMs: 5 });
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
			expect((await getModelCatalog()).models[0]?.id).toBe("claude-sonnet-5");
		});

		it("does not refresh before a persisted future nextRefreshAt", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "1";
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now(),
				source: "live",
				nextRefreshAt: Date.now() + 60 * 60 * 1000,
			});

			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).not.toHaveBeenCalled();
			expect((await getModelCatalog()).models[0]?.id).toBe("old-model");
		});

		it("clamps a stale persisted nextRefreshAt down when the refresh interval has been lowered since it was written", async () => {
			const fetchedAt = Date.now();
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt,
				source: "live",
				// Computed under a long-since-abandoned much larger interval.
				nextRefreshAt: fetchedAt + 1000 * 60 * 60 * 1000,
			});
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";

			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, { initialDelayMs: 5 });
			await new Promise((resolve) => setTimeout(resolve, 40));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
		});

		it("does not run overlapping refreshes while a refresh is still in flight (in-progress guard)", async () => {
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";
			let fetchCallCount = 0;
			const gate = deferred<Response>();
			global.fetch = mock(async () => {
				fetchCallCount++;
				return gate.promise;
			}) as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});

			// Several heartbeat ticks elapse while the first fetch is still
			// pending; none of them should start a second overlapping refresh.
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(fetchCallCount).toBe(1);

			gate.resolve(
				new Response(
					JSON.stringify({
						data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
						has_more: false,
					}),
					{ status: 200 },
				),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			unregister();

			expect((await getModelCatalog()).source).toBe("live");
		});

		it("recovers on a later tick once an eligible account becomes available after a failed refresh", async () => {
			// Effectively-zero interval (and thus effectively-zero jitter, since
			// jitter is bounded by the interval) so the derived due time is
			// "now", deterministically, regardless of jitter randomness.
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0.0000000001";
			const accounts: Account[] = [];
			const fetchMock = mock(
				async () =>
					new Response(
						JSON.stringify({
							data: [
								{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
							],
							has_more: false,
						}),
						{ status: 200 },
					),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx(accounts);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.03,
			});

			// First tick: no eligible account, refresh fails; fetch never runs.
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(fetchMock).not.toHaveBeenCalled();
			expect((await getModelCatalog()).source).toBe("fallback");

			// A console account becomes available; a later tick should pick it
			// up rather than waiting out the (already tiny) nominal interval.
			accounts.push(makeAccount());
			await new Promise((resolve) => setTimeout(resolve, 100));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
			expect((await getModelCatalog()).source).toBe("live");
		});

		it("does not fire if unregistered before the initial refresh check resolves", async () => {
			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx, {
				initialDelayMs: 5,
				tickSeconds: 0.02,
			});
			unregister();

			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe("ingestModelsListing", () => {
		it("replaces the catalog outright for a complete listing (has_more: false, no after_id)", async () => {
			await writeCacheFile({
				models: [
					{ id: "old-model", displayName: "Old Model", createdAt: null },
				],
				fetchedAt: Date.now() - 1000,
				source: "live",
			});

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models).toEqual([
				{
					id: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					createdAt: null,
				},
			]);
		});

		it("merges by id (upsert, no deletions) for a partial listing observed while the catalog is already live", async () => {
			await writeCacheFile({
				models: [
					{ id: "model-a", displayName: "Model A", createdAt: null },
					{ id: "model-b", displayName: "Model B (old name)", createdAt: null },
				],
				fetchedAt: Date.now() - 1000,
				source: "live",
			});

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "model-b", display_name: "Model B" }],
					has_more: true,
					last_id: "model-b",
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models).toEqual([
				{ id: "model-a", displayName: "Model A", createdAt: null },
				{ id: "model-b", displayName: "Model B", createdAt: null },
			]);
		});

		it("skips a partial listing observed while the existing catalog is still the bundled fallback", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-partial-model", display_name: "Partial Model" }],
					has_more: true,
					last_id: "test-partial-model",
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-partial-model")).toBe(
				false,
			);
		});

		it("treats a request carrying after_id as partial even when the observed page's has_more is false", async () => {
			await writeCacheFile({
				models: [{ id: "model-a", displayName: "Model A", createdAt: null }],
				fetchedAt: Date.now() - 1000,
				source: "live",
			});

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "model-b", display_name: "Model B" }],
					has_more: false,
				}),
				makeAccount(),
				"?after_id=model-a",
			);

			const catalog = await getModelCatalog();
			expect(catalog.models).toEqual([
				{ id: "model-a", displayName: "Model A", createdAt: null },
				{ id: "model-b", displayName: "Model B", createdAt: null },
			]);
		});

		it("does not capture from an account whose provider is not an eligible Anthropic provider", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-exotic-model", display_name: "Exotic Model" }],
					has_more: false,
				}),
				makeAccount({ provider: "zai" }),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-exotic-model")).toBe(
				false,
			);
		});

		it("does not capture from an account with a custom_endpoint override (third-party poisoning gate)", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-foreign-model", display_name: "Foreign Model" }],
					has_more: false,
				}),
				makeAccount({ custom_endpoint: "https://compatible.example.com" }),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-foreign-model")).toBe(
				false,
			);
		});

		it("is a no-op when BETTER_CCFLARE_MODELS_OFFLINE=1", async () => {
			process.env.BETTER_CCFLARE_MODELS_OFFLINE = "1";

			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-offline-model", display_name: "Offline Model" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-offline-model")).toBe(
				false,
			);
		});

		it("never throws on a malformed JSON body and leaves the catalog untouched", async () => {
			await expect(
				ingestModelsListing("{not valid json", makeAccount(), null),
			).resolves.toBeUndefined();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
		});

		it("is a no-op when the observed data array is empty", async () => {
			await ingestModelsListing(
				JSON.stringify({ data: [], has_more: false }),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
		});

		it("is a no-op when no account is present", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "test-no-account-model", display_name: "No Account" }],
					has_more: false,
				}),
				null,
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("fallback");
			expect(catalog.models.some((m) => m.id === "test-no-account-model")).toBe(
				false,
			);
		});

		it("recomputes and persists nextRefreshAt on a successful replace", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			const catalog = await getModelCatalog();
			expect(catalog.nextRefreshAt).toBeGreaterThan(catalog.fetchedAt);
		});

		it("persists the replaced catalog to disk and reloads it in a fresh store instance", async () => {
			await ingestModelsListing(
				JSON.stringify({
					data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
					has_more: false,
				}),
				makeAccount(),
				null,
			);

			resetModelCatalogForTest();

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");
			expect(catalog.models[0]?.id).toBe("claude-sonnet-5");
		});
	});
});
