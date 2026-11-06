/**
 * The terminal `vision_unsupported` verdict: when every route ELIGIBLE for an
 * image request is known unable to read it, the answer is a permanent 400 — not
 * the `pool_exhausted` / all-accounts-failed 503 with a `Retry-After`, which
 * tells the client to come back for something that will fail identically
 * forever.
 *
 * "Known" is either of two things, and the second is the reason this verdict
 * exists at all:
 *
 *   1. the candidate was attempted and its upstream refused the image;
 *   2. the candidate was never attempted because the vision capability cache
 *      already records its (account, model) pair as blind.
 *
 * Anything else — a candidate the probe gate suppressed, a combo slot the
 * selector dropped for a model cooldown, an account the strategy left out for a
 * rate-limit window, one usage throttling held back — is only *temporarily*
 * out, so it keeps the request retryable UNLESS the cache already knows that
 * exact pair blind. That last clause is the whole point of building the verdict
 * on the cache rather than on availability: knowledge survives cooldowns, probes
 * and capacity filters, availability does not.
 *
 * The first attempt at this verdict counted only the candidates that survived
 * selection, so one blind slot plus one cooling slot read as "every candidate
 * refused" and answered a permanent 400 for a request that would have succeeded
 * once the cooldown lifted. It was reverted rather than patched again (e64e7f13).
 * The two cooling-slot cases below are that defect pinned in both directions.
 *
 * Harness note: this mirrors vision-capability-skip.test.ts — an unregistered
 * provider name so `ctx.provider` is used verbatim, and per-account hostnames in
 * `buildUrl` so the fetch mock can answer per account and the assertions can name
 * the accounts that were actually asked. Everything runs offline.
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
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	clearFamilyExhaustionForAccount,
	markFamilyExhausted,
} from "../handlers/model-capacity";
import {
	markModelCooling,
	resetModelCooldownsForTests,
} from "../handlers/model-cooldown";
import {
	getRateLimitProbeAdmission,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import {
	clearVisionCapability,
	markVisionUnsupported,
} from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/** The model a plain (non-combo) request asks for. Invented, not a real pin. */
const REQUEST_MODEL = "verdict-model-requested";
/** A model whose family resolves, so combo routing is reached. */
const FAMILY_MODEL = "claude-haiku-4-5";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account-one",
		provider: "test-provider",
		api_key: "test-key",
		// No refresh_token, so the all-accounts-failed `needsReauth` throw cannot
		// claim the request ahead of the verdict under test.
		refresh_token: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-test",
		name: "test-combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function slot(
	id: string,
	accountId: string,
	model: string,
	priority: number,
): ComboWithSlots["slots"][number] {
	return {
		id,
		combo_id: "combo-test",
		account_id: accountId,
		model,
		priority,
		enabled: true,
	};
}

function makeContext(
	accounts: Account[],
	opts: {
		combo?: ComboWithSlots | null;
		sessionFallback?: boolean;
		throttling?: boolean;
		capacityRouting?: boolean;
		/**
		 * Classify a 529 as a rate limit, the way a real anthropic-shaped
		 * provider does when the upstream's overload response carries the
		 * rate-limit status headers. Only with this is the terminal-attempt flag
		 * observable on a 529: an unclassified one is forwarded to the client on
		 * any attempt, terminal or not.
		 */
		rateLimitOn529?: boolean;
	} = {},
): ProxyContext {
	return {
		strategy: {
			// The same availability filter the real strategies apply: an account
			// with a future rate_limited_until never reaches the candidate loop.
			// That drop is invisible to proxy.ts, which is exactly why the selector
			// records what it deferred.
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						!acc.requires_reauth &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => opts.combo ?? null),
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getWebSearchEnabled: () => false,
			getWebSearchBypassHeader: () => true,
			getUsageThrottlingFiveHourEnabled: () => opts.throttling ?? false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getComboSessionFallback: () => opts.sessionFallback ?? true,
			getModelScopedCapacityRouting: () =>
				opts.capacityRouting ? "exhausted" : "off",
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "test-provider",
			canHandle: () => true,
			buildUrl: (path: string, _query: string, account?: Account) =>
				`https://${account?.name ?? "unknown"}.upstream.test${path}`,
			prepareHeaders: () => new Headers(),
			transformRequestBody: undefined,
			processResponse: async (r: Response) => r,
			parseRateLimit: (response: Response) => ({
				isRateLimited: opts.rateLimitOn529 === true && response.status === 529,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

/**
 * An image on the wire is what arms the vision classifier at all.
 *
 * `opts.provider` adds a CLIENT-supplied `provider` routing object — routing
 * the (account, model) capability key cannot represent.
 */
function imageRequest(
	model: string = REQUEST_MODEL,
	opts: { provider?: unknown; excludeProviders?: string } = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(opts.excludeProviders
				? { "x-better-ccflare-exclude-providers": opts.excludeProviders }
				: {}),
		},
		body: JSON.stringify({
			model,
			...(opts.provider === undefined ? {} : { provider: opts.provider }),
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is in this picture" },
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "abc" },
						},
					],
				},
			],
			max_tokens: 16,
		}),
	});
}

/** The 400 an upstream sends when the model cannot read images. */
function visionRejection(): Response {
	return new Response(
		JSON.stringify({
			error: { message: "This model does not support image input." },
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function served(): Response {
	return new Response(JSON.stringify({ type: "message", id: "msg_1" }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * A failure that is not about the image: proxyWithAccount retries it in place
 * once, benches the account and fails over, so the candidate counts as attempted
 * with its capability still unknown.
 */
function serverError(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "api_error", message: "Internal server error" },
		}),
		{ status: 500, headers: { "content-type": "application/json" } },
	);
}

/**
 * A persistent upstream overload. The terminal-attempt flag exists for exactly
 * this status: on the LAST candidate a classified 529 is forwarded to the
 * client — its own status and explanation — while on any earlier candidate it
 * is discarded so failover can continue.
 */
function overloaded529(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "overloaded_error", message: "Upstream at capacity" },
		}),
		{ status: 529, headers: { "content-type": "application/json" } },
	);
}

/** Answers by account name; `callIndex` is per-account, from 1. */
type UpstreamScript = (accountName: string, callIndex: number) => Response;

/** Every account refuses the image. */
const allRefuse: UpstreamScript = () => visionRejection();

interface RunOutcome {
	status: number;
	/** Account names actually fetched, in order (repeats included). */
	fetched: string[];
	/** True when handleProxy threw the retryable all-accounts-failed 503. */
	threw: boolean;
	errorType: string | undefined;
	/** `error.code`, for the refusals that carry one. */
	code: string | undefined;
	poolStatus: string | null;
	retryAfter: string | null;
}

/**
 * Runs one request with `fetch` mocked. A permanent vision refusal comes back as
 * a Response; the retryable paths either return a pool envelope or throw
 * `ServiceUnavailableError` (which the server maps to a hard 503), so a throw is
 * normalised into the same shape rather than escaping the test.
 */
async function run(
	ctx: ProxyContext,
	request: Request,
	upstream: UpstreamScript = allRefuse,
): Promise<RunOutcome> {
	const fetched: string[] = [];
	const perAccountCalls = new Map<string, number>();
	const collectorSpy = stubUsageCollector();
	const realFetch = globalThis.fetch;
	globalThis.fetch = mock(async (input: unknown) => {
		const url =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.toString()
					: String(input);
		const account = new URL(url).hostname.split(".")[0];
		fetched.push(account);
		const callIndex = (perAccountCalls.get(account) ?? 0) + 1;
		perAccountCalls.set(account, callIndex);
		return upstream(account, callIndex);
	}) as unknown as typeof fetch;

	try {
		const response = await handleProxy(
			request,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const body = (await response.json().catch(() => null)) as {
			error?: { type?: string; code?: string };
		} | null;
		return {
			status: response.status,
			fetched,
			threw: false,
			errorType: body?.error?.type,
			code: body?.error?.code,
			poolStatus: response.headers.get("x-better-ccflare-pool-status"),
			retryAfter: response.headers.get("Retry-After"),
		};
	} catch (error) {
		const statusCode = (error as { statusCode?: number })?.statusCode;
		if (statusCode !== 503) throw error;
		return {
			status: 503,
			fetched,
			threw: true,
			errorType: (error as Error).name,
			code: undefined,
			poolStatus: null,
			retryAfter: null,
		};
	} finally {
		globalThis.fetch = realFetch;
		collectorSpy.mockRestore();
	}
}

/** Shorthand for the two assertions that make the answer "permanent". */
function expectVisionUnsupported(result: RunOutcome): void {
	expect(result.status).toBe(400);
	expect(result.errorType).toBe("vision_unsupported");
	expect(result.poolStatus).toBe("vision_unsupported");
	// Waiting cannot help, so neither wait signal may be sent: a client that
	// respects Retry-After would sleep and then fail identically.
	expect(result.retryAfter).toBeNull();
}

/** Shorthand for "the client was told to come back later". */
function expectRetryable(result: RunOutcome): void {
	expect(result.status).toBe(503);
	expect(result.errorType).not.toBe("vision_unsupported");
	expect(result.poolStatus).not.toBe("vision_unsupported");
}

/** An account whose cooldown just expired and whose probe lease is taken. */
function suppress(account: Account): Account {
	const suppressed = {
		...account,
		rate_limited_until: Date.now() - 1,
		rate_limited_reason: "upstream_529_overloaded_no_reset",
	};
	// Takes the single-flight lease, standing in for a concurrent request that is
	// already probing this account's recovery.
	expect(getRateLimitProbeAdmission(suppressed)).toBe("admitted");
	return suppressed;
}

/**
 * Arms usage throttling for one account: a five-hour window past the throttle
 * threshold with a reset still ahead, which is what makes proxy.ts's
 * `applyUsageThrottling` hold it back. 80% is throttled but NOT exhausted, so the
 * selector still returns the account and only the throttle drops it — the drop
 * under test.
 */
function armUsageThrottle(accountId: string): void {
	const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
	usageCache.set(accountId, {
		five_hour: { utilization: 80, resets_at: resetAt },
		seven_day: { utilization: 10, resets_at: null },
	} as never);
}

beforeEach(() => {
	// All of these are process-global module state.
	clearVisionCapability();
	resetModelCooldownsForTests();
	resetRateLimitProbeGatesForTests();
	clearFamilyExhaustionForAccount("acc-1");
	clearFamilyExhaustionForAccount("acc-2");
	clearFamilyExhaustionForAccount("acc-3");
	usageCache.clear();
	process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
	process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
});

afterEach(() => {
	clearVisionCapability();
	resetModelCooldownsForTests();
	resetRateLimitProbeGatesForTests();
	clearFamilyExhaustionForAccount("acc-1");
	clearFamilyExhaustionForAccount("acc-2");
	clearFamilyExhaustionForAccount("acc-3");
	usageCache.clear();
	delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
	delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
});

describe("vision_unsupported — every eligible route was asked and refused", () => {
	it("answers 400 with no Retry-After when every pool candidate refused", async () => {
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({ id: "acc-2", name: "two", priority: 1 }),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one", "two"]);
		expectVisionUnsupported(result);
	});

	it("answers 400 for a combo whose every slot refused", async () => {
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// Both slots under their pins, then the Step-10 fallback pool under the
		// request's own model: four distinct capability questions, all refused.
		expect(result.fetched).toEqual(["one", "two", "one", "two"]);
		expectVisionUnsupported(result);
	});
});

describe("vision_unsupported — every eligible route was skipped from the cache", () => {
	it("answers 400 with ZERO upstream calls when every candidate is known blind", async () => {
		// The case availability-counting could never reach: nothing was attempted,
		// so there are no refusals to count, and the only evidence is the cache.
		markVisionUnsupported("acc-1", REQUEST_MODEL);
		markVisionUnsupported("acc-2", REQUEST_MODEL);
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({ id: "acc-2", name: "two", priority: 1 }),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual([]);
		expectVisionUnsupported(result);
	});

	it("answers 400 for a mix of cached skips and real refusals", async () => {
		markVisionUnsupported("acc-1", REQUEST_MODEL);
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			makeAccount({ id: "acc-3", name: "three", priority: 2 }),
		]);

		const result = await run(ctx, imageRequest());

		// `one` is never asked; the other two are, and both refuse.
		expect(result.fetched).toEqual(["two", "three"]);
		expectVisionUnsupported(result);
	});

	it("leaves a served image alone — the verdict is terminal-only", async () => {
		// Control for everything in this file: when one route CAN read the image the
		// client is answered and the verdict is never consulted, however many other
		// routes are known blind.
		markVisionUnsupported("acc-1", REQUEST_MODEL);
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({ id: "acc-2", name: "two", priority: 1 }),
		]);

		const result = await run(ctx, imageRequest(), (accountName) =>
			accountName === "one" ? visionRejection() : served(),
		);

		expect(result.status).toBe(200);
		expect(result.errorType).toBeUndefined();
		expect(result.poolStatus).toBeNull();
	});
});

describe("vision_unsupported — a temporarily deferred candidate holds the verdict open", () => {
	it("stays retryable when a probe-suppressed candidate was never asked", async () => {
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			suppress(makeAccount({ id: "acc-2", name: "two", priority: 1 })),
		]);

		const result = await run(ctx, imageRequest());

		// Only `one` was asked. `two` is mid-recovery, not blind: its probe may
		// finish in seconds and it may read the image fine.
		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});

	it("stays retryable when the strategy dropped a rate-limited account", async () => {
		// The pool path's selector drop: the account never reaches the candidate
		// loop at all, so only the selector's own record of what it deferred can
		// keep the verdict honest.
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({
				id: "acc-2",
				name: "two",
				priority: 1,
				rate_limited_until: Date.now() + 600_000,
			}),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});

	it("answers 400 when that rate-limited account is already known blind", async () => {
		// The mirror image, and the reason the verdict is built on the cache:
		// availability says `two` is out, knowledge says it could not have served
		// the image even if it were in.
		markVisionUnsupported("acc-2", REQUEST_MODEL);
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({
				id: "acc-2",
				name: "two",
				priority: 1,
				rate_limited_until: Date.now() + 600_000,
			}),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});

	it("answers 400 when the ungated retry covers the only suppressed candidate", async () => {
		// The ungated retry exists for probe suppression: an all-suppressed pool
		// must not fall through to a hard failure. It re-asks the highest-priority
		// candidate, so that candidate stops being "never asked" — and with a sole
		// candidate it was the whole eligible set, making the answer permanent.
		const ctx = makeContext([
			suppress(makeAccount({ id: "acc-1", name: "one" })),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when the ungated retry leaves another suppressed candidate untried", async () => {
		// The same block with two suppressed candidates must NOT claim permanence:
		// the ungated retry covers the first only, so the second was never asked
		// and its capability is still unknown.
		const ctx = makeContext([
			suppress(makeAccount({ id: "acc-1", name: "one" })),
			suppress(makeAccount({ id: "acc-2", name: "two", priority: 1 })),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});

	it("counts the fallback pool's ungated retry, so an all-suppressed fallback still answers 400", async () => {
		// The Step-10 fallback pool has its own ungated retry, and it is a distinct
		// attempt from the main loop's: without counting it, `visionRejections`
		// would outrun `attempted` and a request whose every eligible route is known
		// blind would fall back to a retryable 503.
		//
		// Shape: a one-slot combo whose account is suppressed, so the main loop's
		// ungated retry asks it under the slot's pin; the fallback pool then
		// re-selects both accounts, skips `two` from the cache and suppresses `one`
		// again, leaving its own ungated retry as the only thing that can ask.
		markVisionUnsupported("acc-2", FAMILY_MODEL);
		const combo = makeCombo([slot("slot-0", "acc-1", "slot-model-one", 0)]);
		const ctx = makeContext(
			[
				suppress(makeAccount({ id: "acc-1", name: "one" })),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// `one` under the pin, then `one` again under the request's own model; `two`
		// is never asked at all.
		expect(result.fetched).toEqual(["one", "one"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when usage throttling held a candidate back", async () => {
		// Throttling is applied in proxy.ts AFTER selection, so it is a deferral the
		// selector's own record cannot cover: an account delayed by a usage window
		// is exactly the kind of "only temporarily out" candidate that must keep the
		// request retryable.
		armUsageThrottle("acc-2");
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ throttling: true },
		);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});

	it("answers 400 when the usage-throttled candidate is already known blind", async () => {
		markVisionUnsupported("acc-2", REQUEST_MODEL);
		armUsageThrottle("acc-2");
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ throttling: true },
		);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when the model-scoped capacity filter dropped a candidate", async () => {
		// The capacity filter runs on a separate return path through the selector
		// from the plain pool one, so it records its own deferrals. An account
		// sidelined for a family it has recently seen exhausted is out for minutes,
		// not for good.
		markFamilyExhausted("acc-2", "haiku");
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ capacityRouting: true },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});

	it("answers 400 when the capacity-excluded candidate is already known blind", async () => {
		markFamilyExhausted("acc-2", "haiku");
		markVisionUnsupported("acc-2", FAMILY_MODEL);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ capacityRouting: true },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when the Step-10 fallback pool throttled a candidate back", async () => {
		// The combo's own slots were all asked, so a verdict that only looked at the
		// combo would claim permanence here. The fallback pool is part of the
		// eligible set too, and throttling held one of its candidates back.
		armUsageThrottle("acc-2");
		const combo = makeCombo([slot("slot-0", "acc-1", "slot-model-one", 0)]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo, throttling: true },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// `one` under its slot pin, then again under the request's own model in the
		// fallback pool. `two` is never asked.
		expect(result.fetched).toEqual(["one", "one"]);
		expectRetryable(result);
	});

	it("stays retryable when a combo slot is cooling on a model of unknown capability", async () => {
		// The defect that got the first attempt reverted: the cooling slot is
		// dropped by the selector, so it never reaches `attempted`, and a verdict
		// that counted only surviving candidates read "one slot, one refusal" as
		// "every eligible route refused".
		markModelCooling("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// `two` is still asked — but under the request's own model, in the Step-10
		// fallback pool. The COOLING pair (two, slot-model-two) is the one that was
		// never asked, and its capability is unknown, so the answer stays retryable.
		expect(result.fetched).toEqual(["one", "one", "two"]);
		expectRetryable(result);
	});

	it("answers 400 when that cooling combo slot is already known blind", async () => {
		// The key improvement: a cooling slot that is KNOWN blind no longer blocks
		// the verdict. Knowledge survives the cooldown; availability does not.
		markModelCooling("acc-2", "slot-model-two");
		markVisionUnsupported("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one", "one", "two"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when an attempt failed for a reason other than the image", async () => {
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({ id: "acc-2", name: "two", priority: 1 }),
		]);

		// `one` fails on a transient 5xx and fails over, `two` refuses the image.
		// One refusal out of two attempts is not "every eligible route is blind":
		// `one`'s capability was never established either way, so permanence is not
		// earned and the request must stay retryable.
		//
		// The 5xx has to be on the NON-last candidate: proxy.ts marks the last
		// attempted candidate of a pool-routed request as terminal, and a terminal
		// 5xx is forwarded to the client rather than failed over.
		const result = await run(ctx, imageRequest(), (accountName) =>
			accountName === "one" ? serverError() : visionRejection(),
		);

		expect(result.fetched[result.fetched.length - 1]).toBe("two");
		expectRetryable(result);
	});
});

describe("vision_unsupported — an indefinite hold-out is not a deferred candidate", () => {
	// A candidate only holds the verdict open when waiting could plausibly make
	// it serve the image. Two drop reasons fail that test: a MANUAL pause and a
	// requires-reauth account both return to rotation only by operator action,
	// not with time. Recording them as deferred meant any fleet with one such
	// account could never answer the verdict at all — the feature was inert on
	// a fleet with a single manually paused spare.

	it("answers 400 when the only untried account is a MANUAL pause", async () => {
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({
				id: "acc-2",
				name: "two",
				priority: 1,
				paused: true,
				pause_reason: "manual",
			}),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});

	it("answers 400 when the only untried account needs re-authentication", async () => {
		// needsReauth is computed from the SELECTED accounts, so an account the
		// selector dropped for a dead token is never named by that message.
		// Treating it as deferred blocks the verdict while preserving nothing.
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({
				id: "acc-2",
				name: "two",
				priority: 1,
				requires_reauth: true,
			}),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when the pause is one that auto-resumes", async () => {
		// The boundary: peak-hours, overage and failure-threshold pauses lift
		// themselves (the strategy auto-unpauses everything except reason
		// "manual"), so those accounts ARE deferred candidates and DO hold the
		// verdict open.
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({
				id: "acc-2",
				name: "two",
				priority: 1,
				paused: true,
				pause_reason: "peak_hours",
			}),
		]);

		const result = await run(ctx, imageRequest());

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});
});

describe("vision_unsupported — a refusal belonging to a cycled fallback model is not evidence", () => {
	it("stays retryable when the model-cycling fallback swallowed the refusal", async () => {
		// The retried-response classifier can run AFTER the model-cycling fallback
		// swapped in one of the account's other models. That refusal belongs to a
		// fallback alias reached through a transient failure on the requested model,
		// so it is neither recorded in the cache nor counted toward the verdict:
		// the requested pair's primary may read images fine once the transient
		// clears. `proxyWithAccount` suppresses both behind `modelCycledTo`.
		const ctx = makeContext([
			makeAccount({
				id: "acc-1",
				name: "one",
				// Two entries for the requested model's family, so the cycling loop
				// has somewhere to go.
				model_mappings: JSON.stringify({
					sonnet: ["primary-target-model", "fallback-target-model"],
				}),
			}),
		]);

		const result = await run(
			ctx,
			imageRequest("claude-sonnet-4-5"),
			(_accountName, callIndex) => {
				if (callIndex === 1) {
					// A 429 on the requested model: model-unavailable, so the
					// account's model list is cycled.
					return new Response(
						JSON.stringify({
							error: { type: "api_error", message: "Rate limit exceeded" },
						}),
						{ status: 429, headers: { "content-type": "application/json" } },
					);
				}
				if (callIndex === 2) {
					// A transient 500 on the fallback alias: not model-unavailable, so
					// cycling stops and the 5xx retry re-issues in place.
					return serverError();
				}
				// The retried response denies image input — but it is the alias's
				// answer, not the requested model's.
				return visionRejection();
			},
		);

		expect(result.fetched.length).toBeGreaterThanOrEqual(3);
		expectRetryable(result);
	});
});

describe("vision_unsupported — outranks the combo session-fallback-disabled 503", () => {
	it("names the image cause when every slot refused and fallback is disabled", async () => {
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo, sessionFallback: false },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// The untried pool is not assumed blind — it is checked, and with session
		// fallback disabled nothing was deferred from it either, so the image cause
		// is the accurate one. The config-level 503 says "try again later", which
		// is wrong when no slot can ever read the image.
		expect(result.fetched).toEqual(["one", "two"]);
		expectVisionUnsupported(result);
		expect(result.code).not.toBe("combo_session_fallback_disabled");
	});

	it("still answers combo_session_fallback_disabled for a non-vision failure", async () => {
		const combo = makeCombo([slot("slot-0", "acc-1", "slot-model-one", 0)]);
		const ctx = makeContext([makeAccount({ id: "acc-1", name: "one" })], {
			combo,
			sessionFallback: false,
		});

		const result = await run(ctx, imageRequest(FAMILY_MODEL), () =>
			serverError(),
		);

		expect(result.status).toBe(503);
		expect(result.code).toBe("combo_session_fallback_disabled");
		expect(result.errorType).not.toBe("vision_unsupported");
	});
});

describe("vision_unsupported — an indefinite hold-out is not a deferred COMBO SLOT", () => {
	// The combo counterpart of the pool tests above. A combo slot dropped by the
	// selector's own availability check was recorded as deferred with no
	// eligibility filter — the pool path applies one, the combo path did not —
	// so one manually paused or dead-token slot held the verdict open forever:
	// a combo whose every USABLE slot refuses the image answered a retryable 503
	// instead of the permanent 400. The recording now lives in the selector,
	// beside the account rows and the shared hold-out filter.

	it("answers 400 when the only untried combo slot is a MANUAL pause", async () => {
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({
					id: "acc-2",
					name: "two",
					priority: 1,
					paused: true,
					pause_reason: "manual",
				}),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// `two` is never asked on either path: the selector drops its slot
		// (isAccountAvailable fails a manual pause) and the fallback re-selection's
		// strategy drops the account. `one` is asked under its slot pin and again
		// under the request's own model, and both refuse.
		expect(result.fetched).toEqual(["one", "one"]);
		expectVisionUnsupported(result);
	});

	it("answers 400 when the only untried combo slot needs re-authentication", async () => {
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({
					id: "acc-2",
					name: "two",
					priority: 1,
					requires_reauth: true,
				}),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one", "one"]);
		expectVisionUnsupported(result);
	});

	it("answers 400 when the only untried combo slot's provider is header-excluded", async () => {
		// The third exclusion class the original review finding named, alongside a
		// manual pause and a dead token. A provider excluded for THIS request is
		// permanently ineligible for it rather than temporarily unavailable, so it
		// must not hold the verdict open either.
		//
		// This now exercises the selector's exclusion filter directly: since the
		// slot/account alignment fix, an excluded slot never reaches
		// `slotEntries`, so it DOES appear in the definition-slot diff and must be
		// recognised there as permanently ineligible. Removing that filter fails
		// this test. (Before the alignment fix the filter was unreachable and the
		// right outcome arrived by a different route — an excluded slot was still
		// listed as routable, so the diff never saw it.)
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({
					id: "acc-2",
					name: "two",
					priority: 1,
					provider: "header-excluded-provider",
				}),
			],
			{ combo },
		);

		const result = await run(
			ctx,
			imageRequest(FAMILY_MODEL, {
				excludeProviders: "header-excluded-provider",
			}),
		);

		// `two` is excluded on both the combo path and the fallback re-selection,
		// so only `one` is ever asked — and it refuses both times.
		expect(result.fetched).toEqual(["one", "one"]);
		expectVisionUnsupported(result);
	});

	it("answers 400 when the untried combo slot is BOTH excluded and cooling", async () => {
		// Order dependence: the slot loop drops a slot for model cooldown BEFORE it
		// checks the header exclusion, so an excluded-and-cooling slot never reached
		// the excluded-id set and was recorded as a merely-temporary deferral —
		// holding the verdict open for a route that is permanently ineligible for
		// THIS request. Exclusion has to win over cooldown, because a cooldown ends
		// and an exclusion for this request does not.
		markModelCooling("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({
					id: "acc-2",
					name: "two",
					priority: 1,
					provider: "header-excluded-provider",
				}),
			],
			{ combo },
		);

		const result = await run(
			ctx,
			imageRequest(FAMILY_MODEL, {
				excludeProviders: "header-excluded-provider",
			}),
		);

		// `two` is excluded on the combo path and on the fallback re-selection, so
		// only `one` is ever asked — and it refuses both times.
		expect(result.fetched).toEqual(["one", "one"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when a combo slot points at an account that no longer exists", async () => {
		// Deliberate and conservative, pinned so the choice is visible: a
		// definition slot whose account row is gone means a broken combo, and its
		// capability is unknowable, so it holds the verdict open rather than
		// letting a permanent 400 rest on a guess about a route that no longer
		// exists. Fixing the combo is the operator's action, and a retryable
		// answer is the honest one until then.
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-ghost", "slot-model-two", 1),
		]);
		const ctx = makeContext([makeAccount({ id: "acc-1", name: "one" })], {
			combo,
		});

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// `one` is asked twice: once for its combo slot, then again by the
		// session-fallback re-selection. The ghost slot is never askable.
		expect(result.fetched).toEqual(["one", "one"]);
		expectRetryable(result);
	});

	it("stays retryable when the combo slot's pause is one that auto-resumes", async () => {
		// The boundary, for the combo path: a peak-hours, overage or
		// failure-threshold pause lifts itself, so that slot IS a deferred
		// candidate and does hold the verdict open.
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({
					id: "acc-2",
					name: "two",
					priority: 1,
					paused: true,
					pause_reason: "peak_hours",
				}),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one", "one"]);
		expectRetryable(result);
	});

	it("stays retryable when an auto-resuming pause holds a combo slot back and no fallback pool exists", async () => {
		// Isolates the SELECTOR-side combo recording: with session fallback off
		// there is no pool re-selection to defer `two` a second time, so the only
		// thing holding the verdict open is the selector's own record of the
		// dropped slot. A peak-hours pause auto-resumes, so it is a deferral and
		// not a hold-out.
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({
					id: "acc-2",
					name: "two",
					priority: 1,
					paused: true,
					pause_reason: "peak_hours",
				}),
			],
			{ combo, sessionFallback: false },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});

	it("answers 400 when that auto-resuming combo slot is already known blind under its pin", async () => {
		// The mirror: knowledge survives the auto-resuming pause, so the same
		// shape with the pin marked blind is permanent rather than retryable.
		markVisionUnsupported("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({
					id: "acc-2",
					name: "two",
					priority: 1,
					paused: true,
					pause_reason: "peak_hours",
				}),
			],
			{ combo, sessionFallback: false },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});

	it("stays retryable when usage throttling held a combo slot back", async () => {
		// Throttling is applied in proxy.ts AFTER selection, so it is the one
		// combo deferral the selector cannot record — and it is time-bound, so it
		// holds the verdict open without any eligibility question. Session
		// fallback is off to keep the verdict down to the combo's own slots.
		armUsageThrottle("acc-2");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo, throttling: true, sessionFallback: false },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});

	it("answers 400 when the throttled combo slot is already known blind under its pin", async () => {
		// The pin is what the throttled deferral is recorded under — NOT the
		// request's own model, which under combo routing was never on offer for
		// that account. The entry below is keyed on the slot's pin, so it clears
		// the deferral; had the recording used the request's model, this would
		// still be retryable.
		markVisionUnsupported("acc-2", "slot-model-two");
		armUsageThrottle("acc-2");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo, throttling: true, sessionFallback: false },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one"]);
		expectVisionUnsupported(result);
	});
});

describe("vision_unsupported — a combo whose every slot is cooling still defers its pins", () => {
	// The combo branch has three exits: return the routable slots, return [] when
	// session fallback is disabled, and fall through to SessionStrategy when it
	// is enabled. Only the first recorded the dropped slots, so a combo whose
	// pins were ALL cooling fell through with its pins unrecorded, the pool
	// routes refused the image, and the verdict saw nothing deferred — a
	// permanent 400 about a combo pin that could read the image once its
	// cooldown lifted. Same defect class as the reverted first attempt: the
	// verdict needs every ELIGIBLE candidate, not just the selected ones.

	it("stays retryable when every combo slot is cooling and the fallback pool refuses", async () => {
		markModelCooling("acc-1", "slot-model-one");
		markModelCooling("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		// No combo slot was routable, so both accounts are asked only in the
		// Step-10 fallback pool, under the request's own model, and both refuse.
		// The two pinned (account, pin) pairs were never asked and their
		// capability is unknown, so the answer stays retryable.
		expect(result.fetched).toEqual(["one", "two"]);
		expectRetryable(result);
	});

	it("answers 400 when those cooling combo pins are already known blind", async () => {
		// Knowledge outranks availability — the property the cache exists for. The
		// pins are cooling, but the cache already knows each of them refuses the
		// image, so nothing that could serve it was deferred.
		markModelCooling("acc-1", "slot-model-one");
		markModelCooling("acc-2", "slot-model-two");
		markVisionUnsupported("acc-1", "slot-model-one");
		markVisionUnsupported("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one", "two"]);
		expectVisionUnsupported(result);
	});

	it("still answers combo_session_fallback_disabled when every combo slot is cooling", async () => {
		// With fallback disabled the second exit returns [] without routing a
		// pool at all. The verdict must not claim permanence there either: the
		// cooling pins are deferred and their capability unknown, so the config
		// 503 — not a vision_unsupported 400 — is the honest answer.
		markModelCooling("acc-1", "slot-model-one");
		markModelCooling("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo, sessionFallback: false },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual([]);
		expect(result.status).toBe(503);
		expect(result.code).toBe("combo_session_fallback_disabled");
		expect(result.errorType).not.toBe("vision_unsupported");
	});

	it("treats a cooling slot beside a surviving one as the unknown pair it is", async () => {
		// The mixed shape the initial-selection tests above cover, restated here
		// only as a control for the all-cooling cases: one slot routes, refuses,
		// and the cooling sibling keeps the answer retryable.
		markModelCooling("acc-2", "slot-model-two");
		const combo = makeCombo([
			slot("slot-0", "acc-1", "slot-model-one", 0),
			slot("slot-1", "acc-2", "slot-model-two", 1),
		]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo, sessionFallback: false },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL));

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});
});

describe("vision_unsupported — the cache does not prove a deferred pair blind under a client provider", () => {
	// The verdict's deferred-pair check reads the same cache the skip does, so
	// it owes the same honesty: an entry learned under routing this request does
	// not carry cannot prove a DEFERRED pair blind either, or a client `provider`
	// would let a refusal learned under other routing answer a permanent 400 for
	// a pair that was never asked under this routing. First-hand refusals still
	// count — they happened under this request's own routing.

	it("stays retryable when the deferred pair's cached blindness was learned under other routing", async () => {
		// `two` is rate-limited, so the selector drops it and records it as
		// deferred under the request's own model — and that exact pair is
		// cached-blind. Without the client `provider` this answers 400 (the
		// mirror test in the deferred-candidate describe above); with it, the
		// entry says nothing about the upstream the client's provider selects.
		markVisionUnsupported("acc-2", REQUEST_MODEL);
		const ctx = makeContext([
			makeAccount({ id: "acc-1", name: "one" }),
			makeAccount({
				id: "acc-2",
				name: "two",
				priority: 1,
				rate_limited_until: Date.now() + 600_000,
			}),
		]);

		const result = await run(
			ctx,
			imageRequest(REQUEST_MODEL, { provider: { only: ["client-upstream"] } }),
		);

		expect(result.fetched).toEqual(["one"]);
		expectRetryable(result);
	});
});

describe("vision_unsupported — the last-attempt look-ahead counts a vision-skipped tail", () => {
	// `proxyWithAccount`'s terminal-attempt flag decides whether a persistent
	// upstream 502/529 is FORWARDED to the client or discarded so failover can
	// continue. The loops computed it from the probe gate alone: a tail
	// candidate the vision cache will skip is not probe-suppressed, so the
	// preceding account looked non-terminal, its 529 was discarded, the tail was
	// skipped, and the client got a generic 503 instead of the upstream's own
	// status and explanation.

	it("forwards the head's terminal 529 when the tail is cached-blind", async () => {
		markVisionUnsupported("acc-2", REQUEST_MODEL);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ rateLimitOn529: true },
		);

		const result = await run(ctx, imageRequest(), (accountName) =>
			accountName === "one" ? overloaded529() : served(),
		);

		// `two` is never fetched — skipped from the cache — and because the
		// look-ahead counted that skip, `one` was the last attempted candidate:
		// the client gets the upstream's own 529 and explanation.
		expect(result.fetched).not.toContain("two");
		expect(result.threw).toBe(false);
		expect(result.status).toBe(529);
		expect(result.errorType).toBe("overloaded_error");
	});

	it("still forwards the terminal 529 when the tail is probe-suppressed", async () => {
		// The control: a probe-suppressed tail already made the head terminal
		// before the look-ahead learned about vision skips, and it must keep
		// doing so.
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				suppress(makeAccount({ id: "acc-2", name: "two", priority: 1 })),
			],
			{ rateLimitOn529: true },
		);

		const result = await run(ctx, imageRequest(), (accountName) =>
			accountName === "one" ? overloaded529() : served(),
		);

		expect(result.fetched).not.toContain("two");
		expect(result.threw).toBe(false);
		expect(result.status).toBe(529);
		expect(result.errorType).toBe("overloaded_error");
	});

	it("forwards the fallback pool's terminal 529 when its tail is cached-blind", async () => {
		// Same defect on the Step-10 fallback loop's own look-ahead. The combo
		// slot's pin is cached-blind, so the main loop never asks `one` and falls
		// through to the fallback pool, which re-selects both accounts: `one` is
		// asked under the request's own model (not marked), and `two` under that
		// same key is marked blind, so the tail will be skipped and `one` is
		// terminal.
		markVisionUnsupported("acc-1", "slot-model-one");
		markVisionUnsupported("acc-2", FAMILY_MODEL);
		const combo = makeCombo([slot("slot-0", "acc-1", "slot-model-one", 0)]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				makeAccount({ id: "acc-2", name: "two", priority: 1 }),
			],
			{ combo, rateLimitOn529: true },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL), (accountName) =>
			accountName === "one" ? overloaded529() : served(),
		);

		expect(result.fetched).not.toContain("two");
		expect(result.threw).toBe(false);
		expect(result.status).toBe(529);
		expect(result.errorType).toBe("overloaded_error");
	});

	it("still forwards the fallback pool's terminal 529 when its tail is probe-suppressed", async () => {
		// The fallback loop's control.
		markVisionUnsupported("acc-1", "slot-model-one");
		const combo = makeCombo([slot("slot-0", "acc-1", "slot-model-one", 0)]);
		const ctx = makeContext(
			[
				makeAccount({ id: "acc-1", name: "one" }),
				suppress(makeAccount({ id: "acc-2", name: "two", priority: 1 })),
			],
			{ combo, rateLimitOn529: true },
		);

		const result = await run(ctx, imageRequest(FAMILY_MODEL), (accountName) =>
			accountName === "one" ? overloaded529() : served(),
		);

		expect(result.fetched).not.toContain("two");
		expect(result.threw).toBe(false);
		expect(result.status).toBe(529);
		expect(result.errorType).toBe("overloaded_error");
	});
});
