import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isModelUnavailableError, proxyWithAccount } from "../proxy-operations";
import {
	FIXTURES,
	isOrphaned,
	makeAccount,
	makeProxyContext,
	makeProxyRequest,
	makeRequestBody,
	makeRequestMeta,
	OVERLOAD_RETRY_ENV_KEYS,
	recordClonesDuring,
	waitForCloneBodiesToSettle,
} from "./clone-leak-harness";

/**
 * Regression guard for the 529 overload path (incident 2026-07-29, issue #354).
 *
 * `Response.clone()` tees the body: it produces a second ReadableStream fed
 * from the same source. A tee branch that is never read and never cancelled
 * stays open and forces the tee to buffer everything the faster branch already
 * consumed. The 529 path cloned responses purely to hand them to
 * `provider.parseRateLimit()`, which is declared synchronous
 * (`parseRateLimit(response: Response): RateLimitInfo` in providers/types.ts)
 * and therefore cannot read a body at all — so every one of those clones was
 * orphaned by construction, once per 529 and once more per in-place retry.
 *
 * The tests assert the invariant rather than the implementation: after the
 * path runs, no Response clone may be left with an unconsumed, non-null body
 * (see `isOrphaned` — a null-body clone holds nothing to retain and can never
 * become `bodyUsed`, so it must not count as a leak; see S7 below).
 */

const ENV_KEYS = [
	...OVERLOAD_RETRY_ENV_KEYS,
	"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
] as const;

describe("529 overload path — no orphaned response clones", () => {
	let originalFetch: typeof globalThis.fetch;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		savedEnv = {};
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
		}
		// Keep the jittered in-place retry backoff negligible.
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "1";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "2";
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	it("leaves no cloned response body unconsumed while handling a reset-less 529 (terminal)", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(FIXTURES.overload529, {
					status: 529,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeProxyRequest(bodyBuffer);

		const clones = await recordClonesDuring(async () => {
			// The terminal-attempt flag routes into the "forward the final 529"
			// branch. forwardToClient needs a UsageCollector that unit tests do
			// not wire up; reaching it is enough for this assertion, so that
			// specific error is tolerated (same workaround as
			// proxy-operations-failover.test.ts — the shared limitation is the
			// test harness, not the path under test).
			try {
				await proxyWithAccount(
					req,
					new URL("https://proxy.local/v1/messages"),
					makeAccount(),
					makeRequestMeta(),
					bodyBuffer,
					() => undefined,
					0,
					makeProxyContext(),
					undefined,
					undefined,
					undefined,
					undefined,
					true,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UsageCollector not initialized")) throw e;
			}
		});

		await waitForCloneBodiesToSettle(clones);

		// Guard against the assertion passing for the wrong reason: if nothing
		// was cloned at all, the path never ran and "no orphans" is vacuous.
		expect(clones.length).toBeGreaterThan(0);
		expect(clones.filter(isOrphaned).length).toBe(0);
	});

	// S1 — Reset-less 529, NON-terminal (failover), one in-place retry.
	it("S1: reset-less 529 failover — retries once, exhausts, fails over with no orphaned clones", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(FIXTURES.overload529, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		const bodyBuffer = makeRequestBody();
		const req = makeProxyRequest(bodyBuffer);
		const account = makeAccount();

		const clones = await recordClonesDuring(async () => {
			const result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				// returnRateLimitedResponseOnExhaustion omitted -> false/failover
			);
			expect(result).toBeNull();
		});

		await waitForCloneBodiesToSettle(clones);

		expect(callCount).toBe(2); // initial + 1 in-place retry (default maxAttempts=2)
		expect(account.rate_limited_reason).toBe(
			"upstream_529_overloaded_no_reset",
		);
		expect(clones.length).toBeGreaterThanOrEqual(1);
		expect(clones.filter(isOrphaned).length).toBe(0);
	});

	// S2 — 529 WITH a reset header (terminal flag true) — no in-place retry.
	it("S2: 529 with a reset header skips the retry loop and leaves no orphaned clones", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(FIXTURES.overload529, {
				status: 529,
				headers: {
					"content-type": "application/json",
					"retry-after": "30",
				},
			});
		});

		const bodyBuffer = makeRequestBody();
		const req = makeProxyRequest(bodyBuffer);
		const account = makeAccount();

		const clones = await recordClonesDuring(async () => {
			try {
				await proxyWithAccount(
					req,
					new URL("https://proxy.local/v1/messages"),
					account,
					makeRequestMeta(),
					bodyBuffer,
					() => undefined,
					0,
					makeProxyContext(),
					undefined,
					undefined,
					undefined,
					undefined,
					true,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UsageCollector not initialized")) throw e;
			}
		});

		await waitForCloneBodiesToSettle(clones);

		expect(callCount).toBe(1); // no in-place retry — resetTime was present
		expect(account.rate_limited_reason).toBe(
			"upstream_529_overloaded_with_reset",
		);
		expect(clones.length).toBeGreaterThanOrEqual(2);
		expect(clones.filter(isOrphaned).length).toBe(0);
	});

	// S3 — Plain 429 (anthropic), no model fallbacks configured. PINS: this
	// route creates no Response clones at all, before or after the fix — the
	// 429 short-circuits isModelUnavailableError before any clone, and
	// processProxyResponse is never reached (proxyWithAccount returns inside
	// the 429 branch). Included to document that fact and to prove
	// processProxyResponse never sees a 429 originating from proxyWithAccount.
	it("S3 (pins): plain 429 with no model fallbacks creates zero Response clones", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(FIXTURES.rateLimit429, {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		});

		const bodyBuffer = makeRequestBody();
		const req = makeProxyRequest(bodyBuffer);
		const account = makeAccount(); // no model_fallbacks / model_mappings

		const clones = await recordClonesDuring(async () => {
			const result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				account,
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
			expect(result).toBeNull();
		});

		expect(callCount).toBe(1);
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		// Exact, not a lower bound: this path is fully synchronous and clone-free.
		expect(clones.length).toBe(0);
	});

	// S4 — SSE/streaming 200 response (anthropic). RED-without-fix: the bare
	// `extractUsageInfo(response.clone())` call-site clone was orphaned pre-fix.
	it("S4: streaming 200 response leaves no orphaned usage-extraction clone", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(FIXTURES.sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeProxyRequest(bodyBuffer);

		const clones = await recordClonesDuring(async () => {
			try {
				await proxyWithAccount(
					req,
					new URL("https://proxy.local/v1/messages"),
					makeAccount(),
					makeRequestMeta(),
					bodyBuffer,
					() => undefined,
					0,
					makeProxyContext(),
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UsageCollector not initialized")) throw e;
			}
		});

		await waitForCloneBodiesToSettle(clones);

		expect(clones.length).toBeGreaterThanOrEqual(1);
		expect(clones.filter(isOrphaned).length).toBe(0);
	});

	// S6 — Two or more in-place retries. RED-without-fix: pre-fix orphan count
	// scales with retry count (one `parseRateLimit(*.clone())` orphan per
	// attempt, plus the terminal clone and the usage call-site clone).
	it("S6: exhausting 3 attempts (2 retries) leaves no orphaned clones", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(FIXTURES.overload529, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const bodyBuffer = makeRequestBody();
		const req = makeProxyRequest(bodyBuffer);
		const account = makeAccount();

		const clones = await recordClonesDuring(async () => {
			try {
				await proxyWithAccount(
					req,
					new URL("https://proxy.local/v1/messages"),
					account,
					makeRequestMeta(),
					bodyBuffer,
					() => undefined,
					0,
					makeProxyContext(),
					undefined,
					undefined,
					undefined,
					undefined,
					true,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UsageCollector not initialized")) throw e;
			}
		});

		await waitForCloneBodiesToSettle(clones);

		expect(callCount).toBe(3); // initial + 2 in-place retries
		expect(account.rate_limited_reason).toBe(
			"upstream_529_overloaded_no_reset",
		);
		expect(clones.length).toBeGreaterThanOrEqual(2);
		expect(clones.filter(isOrphaned).length).toBe(0);
	});

	// S7 — Null-body 529 (terminal flag true). PINS: a null-body clone holds no
	// stream to retain, so this is green on both trees — it exists to prove
	// the cancel guards are crash-safe against a null body and that the
	// refined `isOrphaned` predicate doesn't false-positive on one (a bare
	// `!bodyUsed` check would flag every clone here forever, per Bun's
	// behaviour that cloning a null body never flips `bodyUsed`).
	it("S7 (pins): null-body 529 resolves cleanly with no false-positive orphans", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(null, {
					status: 529,
					headers: { "content-type": "application/json" },
				}),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeProxyRequest(bodyBuffer);

		let threw: unknown;
		const clones = await recordClonesDuring(async () => {
			try {
				await proxyWithAccount(
					req,
					new URL("https://proxy.local/v1/messages"),
					makeAccount(),
					makeRequestMeta(),
					bodyBuffer,
					() => undefined,
					0,
					makeProxyContext(),
					undefined,
					undefined,
					undefined,
					undefined,
					true,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (!msg.includes("UsageCollector not initialized")) {
					threw = e;
				}
			}
		});

		expect(threw).toBeUndefined();

		await waitForCloneBodiesToSettle(clones);

		expect(clones.length).toBeGreaterThanOrEqual(2);
		for (const c of clones) {
			expect(c.body).toBeNull();
		}
		expect(clones.filter(isOrphaned).length).toBe(0);
	});
});

describe("isModelUnavailableError — 529 exclusion (existing behaviour)", () => {
	it("returns false for 529 overloaded responses without cloning", async () => {
		const response = new Response(FIXTURES.overload529, {
			status: 529,
			headers: { "content-type": "application/json" },
		});
		expect(await isModelUnavailableError(response)).toBe(false);
	});
});
