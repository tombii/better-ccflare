import { mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";

/**
 * Shared fixtures and clone-tracking utilities for the issue #354 orphaned
 * response-clone test suite. Extracted from
 * `proxy-operations-529-clone-leak.test.ts` so every scenario file (S1-S10)
 * uses one definition instead of drifting copies.
 *
 * Filename deliberately does NOT match `*.test.ts` so bun does not try to
 * run it as its own test file.
 */

// ── Clone-settlement predicates ──────────────────────────────────────────
//
// A plain `!bodyUsed` orphan check false-positives on a null-body response:
// `new Response(null).clone().bodyUsed` stays `false` forever in Bun — there
// is no stream to consume or cancel, so `bodyUsed` never flips. `isSettled`
// treats a null body as settled by construction; `isOrphaned` is its
// negation restricted to clones that actually carry a body.

/** True once a clone can no longer retain buffered bytes: no body, or its body has been disturbed. */
export function isSettled(clone: Response): boolean {
	return clone.body === null || clone.bodyUsed;
}

/** True for a clone that still holds an open, unconsumed tee branch. */
export function isOrphaned(clone: Response): boolean {
	return clone.body !== null && !clone.bodyUsed;
}

/**
 * Records every Response clone created while `body` runs.
 *
 * The patch is installed around the call and removed in `finally`, not in
 * beforeEach/afterEach: Bun executes every test file in ONE process, so a
 * patch on Response.prototype that survives a throwing assertion would leak
 * into unrelated suites. Keeping the window to exactly this call makes that
 * impossible.
 */
export async function recordClonesDuring(
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
 * Waits until every recorded clone has settled (see `isSettled`), or gives up.
 *
 * Usage extraction runs inside a fire-and-forget IIFE (updateAccountMetadata),
 * so there is no promise the test could await. Polling beats a fixed sleep in
 * both directions: the passing case returns as soon as the readers are done
 * instead of always paying a fixed margin, and the failing case gets a budget
 * generous enough that a loaded machine cannot fake a leak.
 */
export async function waitForCloneBodiesToSettle(
	clones: Response[],
): Promise<void> {
	for (let tick = 0; tick < 200; tick++) {
		if (clones.every(isSettled)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

// ── Fixtures ──────────────────────────────────────────────────────────────

export function makeAccount(overrides: Partial<Account> = {}): Account {
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
	} as Account;
}

export function makeRequestMeta(
	overrides: Partial<RequestMeta> = {},
): RequestMeta {
	return {
		id: "req-clone-leak",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	} as RequestMeta;
}

export function makeRequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
}

/**
 * Context whose provider reports a reset-less 529 — the in-place retry path.
 *
 * NOTE: for an account with provider "anthropic" the `provider` stub below is
 * NOT what drives the run. `proxy-operations.ts` resolves
 * `getProvider(account.provider) || ctx.provider`, and importing
 * `@better-ccflare/providers` populates the registry, so the REAL
 * AnthropicProvider wins and `ctx.provider` is only a fallback. That is
 * deliberate here: the real provider is what supplies `extractUsageInfo`,
 * and its clone is one of the orphans this suite is about. Editing the
 * `parseRateLimit` stub below therefore changes nothing for anthropic-account
 * scenarios — the real implementation reads the fixture's actual status/
 * headers, which is exactly what each scenario's fixture is built to drive.
 */
export function makeProxyContext(
	overrides: Partial<ProxyContext> = {},
): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			resetConsecutiveRateLimits: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			updateRequestUsage: mock(() => Promise.resolve()),
			resetAccountSession: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
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
		...overrides,
	};
}

/** Standard env keys the 529 in-place retry path reads for backoff timing. */
export const OVERLOAD_RETRY_ENV_KEYS = [
	"CCFLARE_OVERLOAD_RETRY_BASE_MS",
	"CCFLARE_OVERLOAD_RETRY_MAX_MS",
] as const;

export function makeProxyRequest(bodyBuffer: ArrayBuffer): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body: bodyBuffer,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Standard fixture bodies (spec §3.4).
 */
export const FIXTURES = {
	overload529:
		'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
	rateLimit429:
		'{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
	sse: 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
} as const;

/**
 * Builds a Zai 1308 (usage-limit) error body whose embedded reset timestamp
 * is self-consistent with `Date.now()` at call time (spec §3.4).
 *
 * `ZaiProvider.parseRateLimitFromBody` parses the "reset at <stamp>" message
 * as Singapore time (UTC+8) and subtracts 8h to get UTC — this fixture does
 * the same math in reverse so the expected `resetUtcMs` is exact.
 */
export function makeZai1308Fixture(): { resetUtcMs: number; body: string } {
	const resetUtcMs = Math.floor((Date.now() + 20_000) / 1000) * 1000;
	const sg = new Date(resetUtcMs + 8 * 3600_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${sg.getUTCFullYear()}-${pad(sg.getUTCMonth() + 1)}-${pad(sg.getUTCDate())} ` +
		`${pad(sg.getUTCHours())}:${pad(sg.getUTCMinutes())}:${pad(sg.getUTCSeconds())}`;
	const body = JSON.stringify({
		type: "error",
		error: {
			type: "1308",
			message: `Usage limit reached for 5 hour. Your limit will reset at ${stamp}`,
		},
	});
	return { resetUtcMs, body };
}
