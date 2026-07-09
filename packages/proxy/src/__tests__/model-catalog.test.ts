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
	initModelCatalogRefresh,
	refreshModelCatalog,
	resetModelCatalogForTest,
} from "../model-catalog";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-anthropic-account",
		provider: "anthropic",
		api_key: null,
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

function makeCtx(accounts: Account[]): ProxyContext {
	return {
		strategy: {} as never,
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		dbOps: { getAllAccounts: async () => accounts } as any,
		runtime: { port: 8080, clientId: "test-client" } as never,
		config: {} as never,
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
		it("selects an active anthropic account and fetches models", async () => {
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
				makeAccount({ id: "low-prio", priority: 10, access_token: "at-low" }),
				makeAccount({ id: "high-prio", priority: 0, access_token: "at-high" }),
			]);
			await fetchLiveModels(ctx);

			expect(usedAccountIds[0]).toBe("Bearer at-high");
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
	});

	describe("initModelCatalogRefresh", () => {
		it("registers a periodic interval and performs an immediate refresh", async () => {
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
			const unregister = initModelCatalogRefresh(ctx);

			// Immediate refresh runs asynchronously in the interval callback; give it a tick.
			await new Promise((resolve) => setTimeout(resolve, 10));

			const catalog = await getModelCatalog();
			expect(catalog.source).toBe("live");

			unregister();
		});

		it("does not register a periodic interval when refresh hours is 0", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "0";
			const fetchMock = mock(
				async () =>
					new Response(JSON.stringify({ data: [], has_more: false }), {
						status: 200,
					}),
			);
			global.fetch = fetchMock as unknown as typeof fetch;

			const ctx = makeCtx([makeAccount()]);
			const unregister = initModelCatalogRefresh(ctx);
			unregister();

			// Should not throw and should be a no-op cleanup.
			expect(typeof unregister).toBe("function");
		});

		it("skips the immediate refresh when a fresh live cache already exists on disk", async () => {
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
			// Populate a live cache (in-memory + disk), then simulate a process
			// restart by dropping the in-memory singleton only.
			await refreshModelCatalog(ctx);
			resetModelCatalogForTest();
			fetchMock.mockClear();

			const unregister = initModelCatalogRefresh(ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			unregister();

			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("performs the immediate refresh when the existing live cache is expired", async () => {
			process.env.BETTER_CCFLARE_MODELS_REFRESH_HOURS = "1";
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
			await refreshModelCatalog(ctx);
			resetModelCatalogForTest();
			fetchMock.mockClear();

			// Rewrite the disk cache with a `fetchedAt` older than the 1h TTL.
			const staleContent = JSON.parse(
				await fs.readFile(
					join(TEST_CACHE_DIR, "anthropic-models.json"),
					"utf-8",
				),
			);
			staleContent.fetchedAt = Date.now() - 2 * 60 * 60 * 1000;
			await fs.writeFile(
				join(TEST_CACHE_DIR, "anthropic-models.json"),
				JSON.stringify(staleContent),
			);

			const unregister = initModelCatalogRefresh(ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
		});

		it("performs the immediate refresh when no cache exists yet", async () => {
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
			const unregister = initModelCatalogRefresh(ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			unregister();

			expect(fetchMock).toHaveBeenCalled();
		});
	});
});
