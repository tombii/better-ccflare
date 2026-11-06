/**
 * Routing-level coverage for the vision capability cache: an (account, model)
 * pair whose upstream answered "this model cannot accept image input" must not
 * be asked again by the next image request.
 *
 * The behaviour that matters most here is KEY CONSISTENCY. The refusal is
 * recorded inside `proxyWithAccount` (proxy-operations.ts, `visionKeyModel`) and
 * read back in the candidate loops (proxy.ts, `visionSkipModel`); if the two
 * expressions ever diverge by one character the cache silently never hits and
 * every image request goes back to paying a round-trip per blind pair. So these
 * tests assert the end-to-end contract — how many upstream calls a repeated
 * image request makes — rather than the store in isolation (the store has its
 * own suite in handlers/__tests__/vision-capability.test.ts).
 *
 * Everything runs offline: `globalThis.fetch` is replaced per run and answers
 * from the account the URL names, so a test can assert both HOW MANY upstream
 * calls happened and WHICH accounts they went to.
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
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import {
	clearVisionCapability,
	isVisionUnsupported,
	markVisionUnsupported,
} from "../handlers/vision-capability";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/** Env var `visionCapabilityTtlMs()` re-reads on every call. */
const TTL_ENV_VAR = "CCFLARE_VISION_CAPABILITY_TTL_MS";
const TTL_AT_IMPORT = process.env[TTL_ENV_VAR];

/** The model a plain (non-combo) request asks for. Invented, not a real pin. */
const REQUEST_MODEL = "test-model-requested";
/** A model whose family resolves, so combo routing is reached. */
const FAMILY_MODEL = "claude-haiku-4-5";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

/**
 * A fully-mocked, UNREGISTERED provider name ("test-provider") so
 * `getProvider(account.provider)` resolves to undefined and falls back to
 * `ctx.provider` — the same trick probe-gate-all-suppressed.test.ts uses, giving
 * the test deterministic control over URL building, header prep and response
 * processing with no real provider transform in the way. An api_key and no
 * refresh_token keeps `getValidAccessToken` local (it returns "" for a key
 * account) and keeps the all-accounts-failed path off its OAuth-reauth branch.
 */
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account-one",
		provider: "test-provider",
		api_key: "test-key",
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

function makeContext(
	accounts: Account[],
	opts: { combo?: ComboWithSlots | null; providerRouting?: boolean } = {},
): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
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
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getComboSessionFallback: () => true,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "test-provider",
			canHandle: () => true,
			// Per-account hostnames so the fetch mock can answer by account and the
			// assertions can name the accounts that were actually asked.
			buildUrl: (path: string, _query: string, account?: Account) =>
				`https://${account?.name ?? "unknown"}.upstream.test${path}`,
			prepareHeaders: () => new Headers(),
			transformRequestBody: undefined,
			processResponse: async (r: Response) => r,
			// `providerRouting` arms `supportsProviderRoutingFor`, the instance hook
			// `resolveSlotRouting` consults first: without it the unregistered
			// "test-provider" answers no, and a slot's routing suffix never becomes
			// `body.provider`.
			supportsProviderRoutingFor: () => opts.providerRouting === true,
			parseRateLimit: () => ({
				isRateLimited: false,
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
 * `opts.provider` adds a CLIENT-supplied `provider` routing object to the body
 * — the field the (account, model) cache key cannot represent. On the
 * anthropic-compatible family it passes through to the upstream untouched.
 */
function imageRequest(
	model: string = REQUEST_MODEL,
	opts: { provider?: unknown } = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
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

/**
 * A text-only request. It still contains the literal string `"type":"image"`
 * inside a text block, which is exactly the shape a real conversation carries
 * (pasted code, a JSON sample) and exactly why the gate walks the parsed body
 * instead of scanning bytes.
 */
function textRequest(model: string = REQUEST_MODEL): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: 'here is a sample block: {"type":"image","source":{"type":"base64"}}',
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

interface RunOutcome {
	status: number;
	/** Account names actually fetched, in order. */
	fetched: string[];
	/** True when handleProxy threw the all-accounts-failed 503. */
	threw: boolean;
}

/**
 * Runs one request with `fetch` mocked: every account named in `refusing`
 * answers the image refusal, everyone else serves.
 */
async function run(
	ctx: ProxyContext,
	request: Request,
	refusing: readonly string[] = [],
): Promise<RunOutcome> {
	const fetched: string[] = [];
	const collectorSpy = stubUsageCollector();
	const realFetch = globalThis.fetch;
	globalThis.fetch = mock(async (input: unknown) => {
		const url =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.toString()
					: String(input);
		// buildUrl puts the account name in the hostname, so the mock can answer
		// per account and the test can assert which accounts were asked.
		const account = new URL(url).hostname.split(".")[0];
		fetched.push(account);
		return refusing.includes(account) ? visionRejection() : served();
	}) as unknown as typeof fetch;

	try {
		const response = await handleProxy(
			request,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		return { status: response.status, fetched, threw: false };
	} catch (error) {
		// An exhausted pool throws; the server maps it to a hard 503.
		const statusCode = (error as { statusCode?: number })?.statusCode;
		if (statusCode !== 503) throw error;
		return { status: 503, fetched, threw: true };
	} finally {
		globalThis.fetch = realFetch;
		collectorSpy.mockRestore();
	}
}

beforeEach(() => {
	clearVisionCapability();
	delete process.env[TTL_ENV_VAR];
});

afterEach(() => {
	clearVisionCapability();
	resetRateLimitProbeGatesForTests();
	if (TTL_AT_IMPORT === undefined) delete process.env[TTL_ENV_VAR];
	else process.env[TTL_ENV_VAR] = TTL_AT_IMPORT;
});

describe("vision capability cache — skip a route that already refused the image", () => {
	it("learns the refusal and makes zero upstream calls for that pair next time", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		const ctx = makeContext([blind, serving]);

		const first = await run(ctx, imageRequest(), ["blind"]);
		expect(first.status).toBe(200);
		expect(first.fetched).toEqual(["blind", "serving"]);

		// The write key is the request's own model, byte-identical to what the
		// candidate loop will look up next time.
		expect(isVisionUnsupported("acc-blind", REQUEST_MODEL)).toBe(true);

		// Same request again: the blind pair must cost nothing at all.
		const second = await run(ctx, imageRequest(), ["blind"]);
		expect(second.status).toBe(200);
		expect(second.fetched).toEqual(["serving"]);
	});

	it("keys a combo slot's provider-routing pin on the UNStrIPPED override", async () => {
		// The case most likely to mismatch: `proxyWithAccount` strips the routing
		// suffix before it patches the body, so `effectiveBodyContext.getModel()`
		// is `pinned-model` while the candidate loop looks the pair up under the
		// slot's raw `pinned-model {"only":["upstream-one"]}`. Recording the
		// stripped form would write one key and read another, forever missing.
		const pinnedModel = 'pinned-model {"only":["upstream-one"]}';
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		const combo = makeCombo([
			{
				id: "slot-0",
				combo_id: "combo-test",
				account_id: "acc-blind",
				model: pinnedModel,
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-1",
				combo_id: "combo-test",
				account_id: "acc-serving",
				model: "second-pinned-model",
				priority: 1,
				enabled: true,
			},
		]);
		const ctx = makeContext([blind, serving], { combo });

		const first = await run(ctx, imageRequest(FAMILY_MODEL), ["blind"]);
		expect(first.status).toBe(200);
		expect(first.fetched).toEqual(["blind", "serving"]);

		// Written under the pin as configured, suffix intact...
		expect(isVisionUnsupported("acc-blind", pinnedModel)).toBe(true);
		// ...and NOT under the stripped model the body actually carried. That
		// entry would be a false positive for every other route serving the bare
		// id on this account, and would never be read by this slot anyway.
		expect(isVisionUnsupported("acc-blind", "pinned-model")).toBe(false);
		// The request's own model is a third, unrelated key.
		expect(isVisionUnsupported("acc-blind", FAMILY_MODEL)).toBe(false);

		const second = await run(ctx, imageRequest(FAMILY_MODEL), ["blind"]);
		expect(second.status).toBe(200);
		expect(second.fetched).toEqual(["serving"]);
	});
});

describe("vision capability cache — a text-only request is not skipped", () => {
	it("still asks a known-blind pair when the request carries no image", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		markVisionUnsupported("acc-blind", REQUEST_MODEL);
		const ctx = makeContext([blind, serving]);

		// The image gate, not the cache, decides whether an image is forwarded: a
		// pair that refuses IMAGES serves text perfectly well, so the candidate is
		// attempted and its fetch happens. This is also the observable half of the
		// "never walk the body for text-only traffic" rule — a request that pays
		// only the Map lookup is a request that still reaches the upstream.
		const result = await run(ctx, textRequest());
		expect(result.fetched).toEqual(["blind"]);
		expect(result.status).toBe(200);

		// And the text-only pass left the learned refusal alone: the very next
		// image request is skipped again.
		expect(isVisionUnsupported("acc-blind", REQUEST_MODEL)).toBe(true);
		const imageRun = await run(ctx, imageRequest(), ["blind"]);
		expect(imageRun.fetched).toEqual(["serving"]);
	});
});

describe("vision capability cache — expiry and invalidation", () => {
	it("attempts the pair again once the entry has expired", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		// Learned 60 seconds ago via the injected `now` — no sleeping, and no
		// dependence on how long the suite takes.
		markVisionUnsupported("acc-blind", REQUEST_MODEL, Date.now() - 60_000);
		// A 30s TTL puts that entry 60s past its expiry; `visionCapabilityTtlMs()`
		// re-reads the env var on every call, so the routing read sees it at once.
		process.env[TTL_ENV_VAR] = "30000";

		const ctx = makeContext([blind, serving]);
		const result = await run(ctx, imageRequest(), ["blind"]);
		expect(result.fetched).toEqual(["blind", "serving"]);
		expect(result.status).toBe(200);
	});

	it("keeps skipping while the entry is inside its TTL", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		// Same 60-second-old entry, but the TTL stays at its 12-hour default, so
		// the entry is nowhere near expiring. This is the control for the test
		// above: without it, "expired" and "skipped" could both pass by accident.
		markVisionUnsupported("acc-blind", REQUEST_MODEL, Date.now() - 60_000);

		const ctx = makeContext([blind, serving]);
		const result = await run(ctx, imageRequest(), ["blind"]);
		expect(result.fetched).toEqual(["serving"]);
		expect(result.status).toBe(200);
	});

	it("attempts the pair again after clearVisionCapability(accountId)", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		markVisionUnsupported("acc-blind", REQUEST_MODEL);
		clearVisionCapability("acc-blind");
		expect(isVisionUnsupported("acc-blind", REQUEST_MODEL)).toBe(false);

		const ctx = makeContext([blind, serving]);
		const result = await run(ctx, imageRequest(), ["blind"]);
		expect(result.fetched).toEqual(["blind", "serving"]);
		expect(result.status).toBe(200);
	});

	it("leaves another account's learned refusal in place when clearing one", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const alsoBlind = makeAccount({
			id: "acc-also-blind",
			name: "also-blind",
			priority: 1,
		});
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 2,
		});
		markVisionUnsupported("acc-blind", REQUEST_MODEL);
		markVisionUnsupported("acc-also-blind", REQUEST_MODEL);

		// Credentials or an endpoint changed for ONE account: only its entries go.
		clearVisionCapability("acc-blind");

		const ctx = makeContext([blind, alsoBlind, serving]);
		const result = await run(ctx, imageRequest(), ["blind", "also-blind"]);
		expect(result.fetched).toEqual(["blind", "serving"]);
		expect(result.status).toBe(200);
		// Still cached: the clear was scoped to the account that changed.
		expect(isVisionUnsupported("acc-also-blind", REQUEST_MODEL)).toBe(true);
	});
});

describe("vision capability cache — an all-skipped pool does not re-ask a blind route", () => {
	it("skips the main loop's ungated retry instead of spending it on a known-blind account", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		markVisionUnsupported("acc-blind", REQUEST_MODEL);
		const ctx = makeContext([blind]);

		// Every candidate was skipped, so `anyAccountAttempted` is false and the
		// probe-gate ungated retry would otherwise re-issue the image request to
		// the one account we already know refuses it. ZERO upstream calls.
		//
		// The fall-through is now a 400 `vision_unsupported` rather than the
		// retryable 503 this asserted before: the sole eligible candidate is known
		// blind, so "come back later" was the wrong answer and the terminal verdict
		// (see vision-unsupported-verdict.test.ts) claims the request instead. What
		// this test is about — the skip, and no round-trip spent re-asking — is
		// unchanged.
		const result = await run(ctx, imageRequest(), ["blind"]);
		expect(result.fetched).toEqual([]);
		expect(result.threw).toBe(false);
		expect(result.status).toBe(400);
	});

	it("skips the combo-fallback pool's ungated retry too", async () => {
		// The slot pin and the request's own model are two different keys, so both
		// are marked: the combo loop skips the pinned pair, then Step 10 re-selects
		// the same account for SessionStrategy fallback — where the key is the
		// request's model — and the fallback loop skips it as well.
		const pinnedModel = "pinned-model";
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		markVisionUnsupported("acc-blind", pinnedModel);
		markVisionUnsupported("acc-blind", FAMILY_MODEL);
		const combo = makeCombo([
			{
				id: "slot-0",
				combo_id: "combo-test",
				account_id: "acc-blind",
				model: pinnedModel,
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeContext([blind], { combo });

		const result = await run(ctx, imageRequest(FAMILY_MODEL), ["blind"]);
		expect(result.fetched).toEqual([]);
		// As above: both pools skipped the only candidate, so the terminal verdict
		// now answers 400 instead of a retryable 503. The assertion this test exists
		// for — neither ungated retry re-asks a blind route — is the empty `fetched`.
		expect(result.threw).toBe(false);
		expect(result.status).toBe(400);
	});
});

describe("vision capability cache — provider routing the key cannot represent", () => {
	// The key is the (account, model) pair, and it represents provider routing
	// ONLY through a suffix on the model. Routing can also travel as a
	// `provider` object on the body, which the key has no place for — and on the
	// anthropic-compatible family a client-supplied `provider` passes through to
	// the upstream untouched. One key therefore cannot cover two provider
	// choices: a refusal learned under one would sideline the other for a whole
	// TTL. Both sides decline to use the cache when the routing is not
	// represented in the key.
	const CLIENT_PROVIDER = { only: ["client-upstream"] };
	const OTHER_CLIENT_PROVIDER = { only: ["other-upstream"] };

	it("records nothing when the refusal arrived under a client-supplied provider", async () => {
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		const ctx = makeContext([blind, serving]);

		const first = await run(
			ctx,
			imageRequest(REQUEST_MODEL, { provider: CLIENT_PROVIDER }),
			["blind"],
		);
		expect(first.status).toBe(200);
		expect(first.fetched).toEqual(["blind", "serving"]);

		// The pair was refused under routing the key cannot name, so nothing is
		// learned under it...
		expect(isVisionUnsupported("acc-blind", REQUEST_MODEL)).toBe(false);

		// ...and the next image request still asks it, whatever provider it
		// carries: a refusal under one upstream choice says nothing about another.
		const second = await run(
			ctx,
			imageRequest(REQUEST_MODEL, { provider: OTHER_CLIENT_PROVIDER }),
			["blind"],
		);
		expect(second.fetched).toEqual(["blind", "serving"]);
	});

	it("does not skip a pre-marked pair when the request carries a client provider", async () => {
		markVisionUnsupported("acc-blind", REQUEST_MODEL);
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		const ctx = makeContext([blind, serving]);

		// The cached refusal was learned under a routing this request does not
		// carry: the pair must be asked, not skipped, and it serves.
		const withProvider = await run(
			ctx,
			imageRequest(REQUEST_MODEL, { provider: CLIENT_PROVIDER }),
		);
		expect(withProvider.fetched).toEqual(["blind"]);
		expect(withProvider.status).toBe(200);

		// Control: the identical pool WITHOUT the provider field skips as before
		// (serving a pre-mark is untouched by a skip), so the suppression above is
		// the client provider's doing, not the mark's.
		const withoutProvider = await run(ctx, imageRequest());
		expect(withoutProvider.fetched).toEqual(["serving"]);
		expect(withoutProvider.status).toBe(200);
	});

	it("learns and skips normally when the slot override carries the routing suffix", async () => {
		// The symmetric case. A slot pin WITH a routing suffix IS represented in
		// the key, even when the client also sent a `provider`: `resolveSlotRouting`
		// overwrites `body.provider` from the pin, so the effective routing is the
		// suffix the key already carries. Learning and skipping both keep working.
		const pinnedModel = 'pinned-model {"only":["upstream-one"]}';
		const blind = makeAccount({ id: "acc-blind", name: "blind" });
		const serving = makeAccount({
			id: "acc-serving",
			name: "serving",
			priority: 1,
		});
		const combo = makeCombo([
			{
				id: "slot-0",
				combo_id: "combo-test",
				account_id: "acc-blind",
				model: pinnedModel,
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-1",
				combo_id: "combo-test",
				account_id: "acc-serving",
				model: "second-pinned-model",
				priority: 1,
				enabled: true,
			},
		]);
		const ctx = makeContext([blind, serving], { combo, providerRouting: true });

		const first = await run(
			ctx,
			imageRequest(FAMILY_MODEL, { provider: CLIENT_PROVIDER }),
			["blind"],
		);
		expect(first.status).toBe(200);
		expect(first.fetched).toEqual(["blind", "serving"]);

		// The refusal under the pinned routing IS learned, keyed on the suffixed
		// pin.
		expect(isVisionUnsupported("acc-blind", pinnedModel)).toBe(true);

		// And the next request under the same pin — client provider included — is
		// skipped off it.
		const second = await run(
			ctx,
			imageRequest(FAMILY_MODEL, { provider: CLIENT_PROVIDER }),
			["blind"],
		);
		expect(second.fetched).toEqual(["serving"]);
	});
});
