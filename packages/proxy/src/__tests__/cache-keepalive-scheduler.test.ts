/**
 * Tests for CacheKeepaliveScheduler.
 *
 * Strategy:
 *   1. mock.module("@better-ccflare/core") intercepts registerHeartbeat so we
 *      can capture the registered callback and trigger sendKeepalives() without
 *      waiting for real timers.
 *   2. mock.module("../dispatch") intercepts dispatchProxyRequest so we can
 *      verify the scheduler dispatches the replay request through the in-process
 *      proxy pipeline (and assert on the synthetic Request it constructs).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { ProxyContext } from "../proxy";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the scheduler so that bun's
// module resolution picks up the mock.
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

// Captures the synthetic Requests the scheduler builds so tests can assert on
// the URL, headers, and body passed to dispatchProxyRequest.
const capturedDispatchCalls: Array<{ req: Request; url: URL }> = [];
const mockDispatchProxyRequest = mock(async (req: Request, url: URL) => {
	capturedDispatchCalls.push({ req, url });
	return new Response("", { status: 200 });
});

mock.module("../dispatch", () => ({
	dispatchProxyRequest: mockDispatchProxyRequest,
}));

import { cacheBodyStore } from "../cache-body-store";
// Import AFTER mock.module so the scheduler gets the mocked registerHeartbeat
// and dispatchProxyRequest.
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
		off: (event: string, cb: ConfigChangeListener) => {
			if (event === "change") {
				const idx = listeners.indexOf(cb);
				if (idx !== -1) listeners.splice(idx, 1);
			}
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
	bodyText = '{"model":"claude-opus-4-5","messages":[],"system":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}',
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
	mockDispatchProxyRequest.mockClear();
	capturedCallback = null;
	capturedSeconds = null;
	capturedId = null;
	capturedDispatchCalls.length = 0;
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
	});

	afterEach(() => {
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

		it("multiple sequential TTL changes — each triggers a restart without losing the listener", () => {
			// This test would have caught the restart() listener-removal bug:
			// the original restart() called stop() which nulled boundConfigChangeHandler,
			// so the second config change was silently dropped.
			const { config, fireTtlChange } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(1);
			expect(capturedSeconds).toBe(240); // (5-1)*60

			// First TTL change: 5 → 10
			fireTtlChange(10);

			expect(mockUnregister).toHaveBeenCalledTimes(1);
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(2);
			expect(capturedSeconds).toBe(540); // (10-1)*60

			// Second TTL change: 10 → 30
			// Before the fix, the listener was removed after the first change and
			// this would be a no-op.
			fireTtlChange(30);

			expect(mockUnregister).toHaveBeenCalledTimes(2);
			expect(mockRegisterHeartbeat).toHaveBeenCalledTimes(3);
			expect(capturedSeconds).toBe(1740); // (30-1)*60

			scheduler.stop();
		});

		it("unrelated config key change is ignored", () => {
			let listener: ConfigChangeListener | null = null;
			const config = {
				getCacheKeepaliveTtlMinutes: () => 5,
				on: (_event: string, cb: ConfigChangeListener) => {
					listener = cb;
				},
				off: () => {},
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
		it("with no cached accounts — dispatchProxyRequest is NOT called", async () => {
			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// Store is enabled but no entries seeded.
			await capturedCallback?.();

			expect(mockDispatchProxyRequest).not.toHaveBeenCalled();

			scheduler.stop();
		});

		it("with one cached account — dispatched once with correct headers", async () => {
			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// cacheBodyStore is now enabled (TTL=5 > 0).
			const accountId = "acc-single";
			const path = "/v1/messages";
			seedCacheEntry(accountId, path);

			await capturedCallback?.();

			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(1);

			const { req, url } = capturedDispatchCalls[0];
			expect(req.method).toBe("POST");
			expect(url.pathname).toBe(path);

			// Verify routing headers were injected.
			expect(req.headers.get("x-better-ccflare-account-id")).toBe(accountId);
			expect(req.headers.get("x-better-ccflare-bypass-session")).toBe("true");
			expect(req.headers.get("x-better-ccflare-keepalive")).toBe("true");
			expect(req.headers.get("content-type")).toBe("application/json");

			scheduler.stop();
		});

		it("with one cached account — body matches the stored body", async () => {
			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			const bodyText =
				'{"model":"claude-opus-4-5","messages":[{"role":"user","content":"hello"}],"system":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}';
			seedCacheEntry("acc-body-check", "/v1/messages", bodyText);

			await capturedCallback?.();

			expect(capturedDispatchCalls).toHaveLength(1);
			const dispatchedBody = await capturedDispatchCalls[0].req.text();
			const decoded = JSON.parse(dispatchedBody);
			// Scheduler patches max_tokens: 1 to minimise quota on replay
			expect(decoded.model).toBe("claude-opus-4-5");
			expect(decoded.messages).toEqual([{ role: "user", content: "hello" }]);
			expect(decoded.max_tokens).toBe(1);

			scheduler.stop();
		});

		it("with two cached accounts — dispatched twice", async () => {
			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedCacheEntry("acc-alpha");
			seedCacheEntry("acc-beta");

			await capturedCallback?.();

			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(2);

			scheduler.stop();
		});

		it("dispatch returns non-ok status — does not throw, handles gracefully", async () => {
			mockDispatchProxyRequest.mockImplementationOnce(
				async () => new Response("Rate limited", { status: 429 }),
			);

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedCacheEntry("acc-rate-limited");

			// Should resolve without throwing.
			await expect(capturedCallback?.()).resolves.toBeUndefined();
			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("dispatch throws — error does not propagate out of the callback", async () => {
			mockDispatchProxyRequest.mockImplementationOnce(async () => {
				throw new Error("synthetic-dispatch-failure");
			});

			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			seedCacheEntry("acc-conn-error");

			// The scheduler must swallow the error internally.
			await expect(capturedCallback?.()).resolves.toBeUndefined();
			expect(mockDispatchProxyRequest).toHaveBeenCalledTimes(1);

			scheduler.stop();
		});

		it("skips account when getLastCachedRequest returns null", async () => {
			const { config } = makeConfig(5);
			const scheduler = new CacheKeepaliveScheduler(makeProxyContext(), config);
			scheduler.start();

			// Seed a staging entry (body has cache_control so stageRequest succeeds),
			// but do NOT call onSummary — staged but never promoted → getLastCachedRequest returns null.
			cacheBodyStore.stageRequest(
				"req-no-promote",
				"acc-no-promote",
				new TextEncoder().encode(
					JSON.stringify({
						model: "claude-opus-4-5",
						messages: [],
						system: [
							{
								type: "text",
								text: "hi",
								cache_control: { type: "ephemeral" },
							},
						],
					}),
				).buffer,
				new Headers(),
				"/v1/messages",
			);
			// Do not call onSummary → getLastCachedRequest will return null for this account.

			await capturedCallback?.();

			// No promoted entries → dispatch should not be called.
			expect(mockDispatchProxyRequest).not.toHaveBeenCalled();

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
