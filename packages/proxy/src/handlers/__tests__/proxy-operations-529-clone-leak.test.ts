import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

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
 * The test asserts the invariant rather than the implementation: after the
 * path runs, no Response clone may be left with an unconsumed body. Cancelling
 * a body disturbs it and thus also satisfies `bodyUsed`, so a fix that keeps a
 * clone but disposes of it passes too.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "clone-leak-test",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-clone-leak",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	} as RequestMeta;
}

function makeRequestBody() {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
}

/** Context whose provider reports a reset-less 529 — the in-place retry path. */
function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			resetConsecutiveRateLimits: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		// NOTE: for an account with provider "anthropic" this stub is NOT what
		// drives the run. proxy-operations.ts resolves
		// `getProvider(account.provider) || ctx.provider`, and importing
		// @better-ccflare/providers populates the registry, so the REAL
		// AnthropicProvider wins and ctx.provider is only a fallback. That is
		// deliberate here: the real provider is what supplies extractUsageInfo,
		// and its clone is one of the orphans this test is about. Editing the
		// parseRateLimit below therefore changes nothing — the real
		// implementation returns isRateLimited/no resetTime for a 529 that
		// carries no reset headers, which is exactly the path we want.
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => false } as never,
		internalProbeSecret: "test-secret",
	};
}

const ENV_KEYS = [
	"CCFLARE_OVERLOAD_RETRY_BASE_MS",
	"CCFLARE_OVERLOAD_RETRY_MAX_MS",
] as const;

/**
 * Records every Response clone created while `body` runs.
 *
 * The patch is installed around the call and removed in `finally`, not in
 * beforeEach/afterEach: Bun executes every test file in ONE process, so a patch
 * on Response.prototype that survives a throwing assertion would leak into
 * unrelated suites. Keeping the window to exactly this call makes that
 * impossible.
 */
async function recordClonesDuring(
	body: () => Promise<void>,
): Promise<Response[]> {
	const clones: Response[] = [];
	const original = Response.prototype.clone;
	Response.prototype.clone = function trackedClone(this: Response) {
		const copy = original.call(this);
		clones.push(copy);
		return copy;
	};
	try {
		await body();
	} finally {
		Response.prototype.clone = original;
	}
	return clones;
}

/**
 * Waits until every recorded clone has had its body consumed, or gives up.
 *
 * The usage extraction in updateAccountMetadata reads its clone inside a
 * fire-and-forget IIFE, so there is no promise the test could await. Polling
 * beats a fixed sleep in both directions: the passing case returns as soon as
 * the readers are done instead of always paying a fixed margin, and the failing
 * case gets a budget generous enough that a loaded machine cannot fake a leak.
 */
async function waitForCloneBodiesToSettle(clones: Response[]): Promise<void> {
	for (let tick = 0; tick < 200; tick++) {
		if (clones.every((c) => c.bodyUsed)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

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
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	it("leaves no cloned response body unconsumed while handling a reset-less 529", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{ status: 529, headers: { "content-type": "application/json" } },
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		});

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
		const orphaned = clones.filter((c) => !c.bodyUsed);
		expect(orphaned.length).toBe(0);
	});
});
