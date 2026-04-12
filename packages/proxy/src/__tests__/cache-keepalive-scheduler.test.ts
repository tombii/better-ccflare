/**
 * Tests for CacheKeepaliveScheduler.
 *
 * Strategy: mock.module("@better-ccflare/core") so registerHeartbeat is
 * intercepted before the scheduler module is imported.  The mock stores the
 * registered callback so individual tests can invoke it directly, which lets
 * us test sendKeepalives() without relying on real timers.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { ProxyContext } from "../proxy";

// ---------------------------------------------------------------------------
// Module mock — must be declared before importing the scheduler so that bun's
// module resolution picks up the mock when it resolves @better-ccflare/core.
// ---------------------------------------------------------------------------

type HeartbeatOpts = {
	id: string;
	callback: () => void | Promise<void>;
	seconds?: number;
	description?: string;
};

// Stores the last registered heartbeat callback so tests can trigger it.
let capturedCallback: (() => void | Promise<void>) | null = null;
let capturedSeconds: number | null = null;
let capturedId: string | null = null;
const mockUnregister = mock(() => {});
const mockRegisterHeartbeat = mock((opts: HeartbeatOpts) => {
	capturedCallback = opts.callback;
	capturedSeconds = opts.seconds ?? 30;
	capturedId = opts.id;
	return mockUnregister;
});

mock.module("@better-ccflare/core", () => ({
	registerHeartbeat: mockRegisterHeartbeat,
	// Re-export other things that the proxy module tree may need (none required
	// by the scheduler itself, but avoids any import-time crash).
	registerCleanup: mock(() => () => {}),
	registerUIRefresh: mock(() => () => {}),
	intervalManager: {
		register: mock(() => () => {}),
		unregister: mock(() => {}),
	},
}));

import { cacheBodyStore } from "../cache-body-store";
// Import AFTER mock.module so the scheduler gets the mocked registerHeartbeat.
import { CacheKeepaliveScheduler } from "../cache-keepalive-scheduler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ProxyContext — scheduler only reads runtime.port. */
function makeProxyContext(port = 8081): ProxyContext {
	return { runtime: { port } } as unknown as ProxyContext;
}

type ConfigChangeListener = (evt: { key: string; newValue: unknown }) => void;

/** Minimal Config mock with a simple event emitter for "change". */
function makeConfig(initialTtl: number): {
	config: Config;
	fireTtlChange: (newTtl: number) => void;
} {
	let ttl = initialTtl;
	const listeners: ConfigChangeListener[] = [];

	const config = {
		getCacheKeepaliveTtlMinutes: () => ttl,
		on: (event: string, cb: ConfigChangeListener) => {
			if (event === "change") listeners.push(cb);
		},
		// Allow tests to mutate TTL and fire the event.
		_setTtl: (v: number) => {
			ttl = v;
		},
	} as unknown as Config;

	const fireTtlChange = (newTtl: number) => {
		(config as unknown as { _setTtl: (v: number) => void })._setTtl(newTtl);
		for (const l of listeners) {
			l({ key: "cache_keepalive_ttl_minutes", newValue: newTtl });
		}
	};

	return { config, fireTtlChange };
}

/** Stage + promote a cached request entry for a given accountId. */
function seedCacheEntry(
	accountId: string,
	path = "/v1/messages",
	bodyText = '{"model":"claude-opus-4-5","messages":[]}',
): void {
	const requestId = `req-${accountId}-${Date.now()}`;
	const bodyBuffer = new TextEncoder().encode(bodyText).buffer;
	const headers = new Headers({ "content-type": "application/json" });
	cacheBodyStore.stageRequest(requestId, accountId, bodyBuffer, headers, path);
	// Promote by simulating a successful cache creation (cacheCreationInputTokens > 0).
	cacheBodyStore.onSummary(requestId, 42);
}

// ---------------------------------------------------------------------------
// Test lifecycle helpers
// ---------------------------------------------------------------------------

function resetMocks(): void {
	mockRegisterHeartbeat.mockClear();
	mockUnregister.mockClear();
	capturedCallback = null;
	capturedSeconds = null;
	capturedId = null;
}

function resetStore(): void {
	// Disable then re-enable to clear internal maps.
	cacheBodyStore.setEnabled(false);
	// Leave disabled — individual tests opt-in via setEnabled(true) or via
	// scheduler.start() which calls setEnabled based on TTL.
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CacheKeepaliveScheduler", () => {
	beforeEach(() => {
		resetMocks();
		resetStore();
		// Restore fetch to a safe default so tests that do NOT mock fetch still work.
		globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));
	});

	afterEach(() => {
		// Restore fetch to the real implementation.
		// @ts-expect-error — resetting to undefined lets bun restore native fetch.
		globalThis.fetch = undefined;
		resetStore();
	});

	// -------------------------------------------------------------------------
	// start() behaviour
	// -------------------------------------------------------------------------

	describe("start()", () => {
		it("TTL=0 — does NOT register a heartbeat and disables the store", () => {
			const { config } = makeConfig(0);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();

			expect(mockRegisterHeartbeat).not.toHaveBeenCalled();
			// Seeding should be a no-op when the store is disabled.
			const requestId = "req-ttl0";
			cacheBodyStore.stageRequest(
				requestId,
				"acc-1",
				new TextEncoder().encode("{}").buffer,
				new Headers(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary(requestId, 10);
			expect(cacheBodyStore.getAllCachedAccounts()).toHaveLength(0);
		});

		it("TTL=5 — registers heartbeat with intervalSeconds=240 and enables store", () => {
			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			expect(capturedSeconds).toBe(240); // (5 - 1) * 60 = 240
			expect(capturedId).toBe("cache-keepalive-scheduler");

			// Store must be enabled — seeding should work.
			seedCacheEntry("acc-5min");
			expect(cacheBodyStore.getAllCachedAccounts()).toContain("acc-5min");

			scheduler.stop();
		});

		it("TTL=1 — interval clamped to 60 s minimum", () => {
			const { config } = makeConfig(1);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			// (1 - 1) * 60_000 = 0 ms → clamped to 60_000 ms → 60 s
			expect(capturedSeconds).toBe(60);

			scheduler.stop();
		});
	});

	// -------------------------------------------------------------------------
	// stop()
	// -------------------------------------------------------------------------

	describe("stop()", () => {
		it("calls the unregister function returned by registerHeartbeat", () => {
			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);

			scheduler.start();
			expect(mockUnregister).not.toHaveBeenCalled();

			scheduler.stop();
			expect(mockUnregister).toHaveBeenCalledTimes(1);
		});

		it("stop() when TTL=0 (no interval registered) does not throw", () => {
			const { config } = makeConfig(0);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(() => scheduler.stop()).not.toThrow();
			expect(mockUnregister).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// Config change events
	// -------------------------------------------------------------------------

	describe("config 'change' events", () => {
		it("change to TTL=0 — unregisters interval and disables the store", () => {
			const { config, fireTtlChange } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			fireTtlChange(0);

			// The original interval should have been unregistered.
			expect(mockUnregister).toHaveBeenCalledTimes(1);
			// No new interval should have been registered.
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			// Store should be disabled.
			seedCacheEntry("acc-disabled");
			expect(cacheBodyStore.getAllCachedAccounts()).toHaveLength(0);

			scheduler.stop();
		});

		it("change to TTL=10 — re-registers with new interval (9*60=540 s)", () => {
			const { config, fireTtlChange } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(capturedSeconds).toBe(240); // initial

			fireTtlChange(10);

			// Old interval unregistered, new one registered.
			expect(mockUnregister).toHaveBeenCalledTimes(1);
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(2);
			expect(capturedSeconds).toBe(540); // (10 - 1) * 60

			scheduler.stop();
		});

		it("change to the SAME TTL — does NOT restart (no-op)", () => {
			const { config, fireTtlChange } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			fireTtlChange(5); // same value

			// Nothing should have changed.
			expect(mockUnregister).not.toHaveBeenCalled();
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("unrelated config key change is ignored", () => {
			let listener: ConfigChangeListener | null = null;
			const config = {
				getCacheKeepaliveTtlMinutes: () => 5,
				on: (_event: string, cb: ConfigChangeListener) => {
					listener = cb;
				},
			} as unknown as Config;

			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			// Fire a change for a different key.
			listener?.({ key: "some_other_key", newValue: 99 });

			expect(mockUnregister).not.toHaveBeenCalled();
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});
	});

	// -------------------------------------------------------------------------
	// sendKeepalives() — triggered via captured heartbeat callback
	// -------------------------------------------------------------------------

	describe("sendKeepalives() (triggered via heartbeat callback)", () => {
		it("with no cached accounts — fetch is NOT called", async () => {
			const fetchMock = mock(async () => new Response("ok", { status: 200 }));
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// Store is enabled but no entries seeded.
			await capturedCallback?.();

			expect(fetchMock).not.toHaveBeenCalled();

			scheduler.stop();
		});

		it("with one cached account — fetch called once with correct URL and headers", async () => {
			const capturedInputs: { url: string; init?: RequestInit }[] = [];
			const fetchMock = mock(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					// When called with a string URL, input is the URL string.
					const url =
						typeof input === "string" ? input : (input as Request).url;
					capturedInputs.push({ url, init });
					return new Response("", { status: 200 });
				},
			);
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const port = 8081;
			const scheduler = new CacheKeepaliveScheduler(
				makeProxyContext(port),
				config,
			);
			scheduler.start();

			// cacheBodyStore is now enabled (TTL=5 > 0).
			const accountId = "acc-single";
			const path = "/v1/messages";
			seedCacheEntry(accountId, path);

			await capturedCallback?.();

			expect(fetchMock).toHaveBeenCalledTimes(1);

			const { url, init } = capturedInputs[0];
			expect(url).toBe(`http://localhost:${port}${path}`);
			expect(init?.method).toBe("POST");

			// Verify routing headers were injected.
			const headers = init?.headers as Headers;
			expect(headers.get("x-better-ccflare-account-id")).toBe(accountId);
			expect(headers.get("x-better-ccflare-bypass-session")).toBe("true");
			expect(headers.get("content-type")).toBe("application/json");

			scheduler.stop();
		});

		it("with one cached account — body matches the stored body", async () => {
			let capturedBody: ArrayBuffer | null = null;
			const fetchMock = mock(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					if (init?.body) {
						// init.body is Uint8Array per replayRequest implementation.
						capturedBody = (init.body as Uint8Array).buffer;
					}
					return new Response("", { status: 200 });
				},
			);
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			const bodyText =
				'{"model":"claude-opus-4-5","messages":[{"role":"user","content":"hello"}]}';
			seedCacheEntry("acc-body-check", "/v1/messages", bodyText);

			await capturedCallback?.();

			expect(capturedBody).not.toBeNull();
			const decoded = new TextDecoder().decode(capturedBody!);
			expect(decoded).toBe(bodyText);

			scheduler.stop();
		});

		it("with two cached accounts — fetch called twice", async () => {
			const fetchMock = mock(async () => new Response("", { status: 200 }));
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedCacheEntry("acc-alpha");
			seedCacheEntry("acc-beta");

			await capturedCallback?.();

			expect(fetchMock).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});

		it("fetch returns non-ok status — does not throw, handles gracefully", async () => {
			const fetchMock = mock(
				async () => new Response("Rate limited", { status: 429 }),
			);
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedCacheEntry("acc-rate-limited");

			// Should resolve without throwing.
			await expect(capturedCallback?.()).resolves.toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("fetch throws — error does not propagate out of the callback", async () => {
			const fetchMock = mock(async () => {
				throw new Error("ECONNREFUSED");
			});
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedCacheEntry("acc-conn-error");

			// The scheduler must swallow the error internally.
			await expect(capturedCallback?.()).resolves.toBeUndefined();
			expect(fetchMock).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("uses https when SSL env vars are set", async () => {
			const capturedUrls: string[] = [];
			const fetchMock = mock(async (input: RequestInfo | URL) => {
				// When called with a string URL, input is the URL string.
				const url = typeof input === "string" ? input : (input as Request).url;
				capturedUrls.push(url);
				return new Response("", { status: 200 });
			});
			globalThis.fetch = fetchMock;

			// Set SSL env vars.
			process.env.SSL_KEY_PATH = "/etc/ssl/key.pem";
			process.env.SSL_CERT_PATH = "/etc/ssl/cert.pem";

			try {
				const { config } = makeConfig(5);
				const scheduler = new CacheKeepaliveScheduler(
					makeProxyContext(8443),
					config,
				);
				scheduler.start();

				seedCacheEntry("acc-ssl");

				await capturedCallback?.();

				expect(capturedUrls[0]).toMatch(/^https:\/\//);
				expect(capturedUrls[0]).toContain("8443");

				scheduler.stop();
			} finally {
				delete process.env.SSL_KEY_PATH;
				delete process.env.SSL_CERT_PATH;
			}
		});

		it("uses http when SSL env vars are absent", async () => {
			delete process.env.SSL_KEY_PATH;
			delete process.env.SSL_CERT_PATH;

			const capturedUrls: string[] = [];
			const fetchMock = mock(async (input: RequestInfo | URL) => {
				// When called with a string URL, input is the URL string.
				const url = typeof input === "string" ? input : (input as Request).url;
				capturedUrls.push(url);
				return new Response("", { status: 200 });
			});
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(
				makeProxyContext(8081),
				config,
			);
			scheduler.start();

			seedCacheEntry("acc-no-ssl");

			await capturedCallback?.();

			expect(capturedUrls[0]).toMatch(/^http:\/\//);

			scheduler.stop();
		});

		it("skips account when getLastCachedRequest returns null", async () => {
			const fetchMock = mock(async () => new Response("", { status: 200 }));
			globalThis.fetch = fetchMock;

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// Seed a staging entry but do NOT call onSummary — so no promoted entry.
			cacheBodyStore.stageRequest(
				"req-no-promote",
				"acc-no-promote",
				new TextEncoder().encode("{}").buffer,
				new Headers(),
				"/v1/messages",
			);
			// Do not call onSummary → getLastCachedRequest will return null for this account.

			await capturedCallback?.();

			// No promoted entries → fetch should not be called.
			expect(fetchMock).not.toHaveBeenCalled();

			scheduler.stop();
		});
	});

	// -------------------------------------------------------------------------
	// cacheBodyStore interaction details
	// -------------------------------------------------------------------------

	describe("cacheBodyStore interaction", () => {
		it("setEnabled(false) is called when TTL changes from >0 to 0 (clears existing entries)", () => {
			const { config, fireTtlChange } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// Seed an entry while enabled.
			seedCacheEntry("acc-pre-disable");
			expect(cacheBodyStore.getAllCachedAccounts()).toHaveLength(1);

			// Change TTL to 0 — should disable the store and clear all entries.
			fireTtlChange(0);

			expect(cacheBodyStore.getAllCachedAccounts()).toHaveLength(0);

			scheduler.stop();
		});

		it("setEnabled(true) is called on re-enable after TTL was 0", () => {
			const { config, fireTtlChange } = makeConfig(0);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// TTL=0 → store disabled.
			const requestId = "req-disabled";
			cacheBodyStore.stageRequest(
				requestId,
				"acc-disabled",
				new TextEncoder().encode("{}").buffer,
				new Headers(),
				"/v1/messages",
			);
			cacheBodyStore.onSummary(requestId, 10);
			expect(cacheBodyStore.getAllCachedAccounts()).toHaveLength(0);

			// Change TTL to 5 → store should be re-enabled.
			fireTtlChange(5);

			// Now seeding should work.
			seedCacheEntry("acc-re-enabled");
			expect(cacheBodyStore.getAllCachedAccounts()).toContain("acc-re-enabled");

			scheduler.stop();
		});
	});
});
