/**
 * `vision_unsupported` is a PERMANENT answer: it tells the client that no
 * eligible model can read the request's image, so retrying cannot help and no
 * `Retry-After` is sent. That is only true when every eligible candidate was
 * actually attempted. These cover the three ways the count could claim a
 * permanence it has not earned (Greptile's review of af0a8fec):
 *
 *   1. a candidate the probe gate skipped was never asked — it is only
 *      *temporarily* unavailable, so it may read the image once its recovery
 *      probe finishes;
 *   2. the main loop's ungated retry was not counted at all, so an
 *      all-suppressed pool that rejected the image fell through to a generic
 *      503 and the client kept retrying an image nothing can serve;
 *   3. a combo with session fallback disabled returned its retryable 503
 *      before the image-specific branch could run.
 *
 * Suppression is armed the way probe-gate-all-suppressed.test.ts does it: an
 * expired 529 cooldown makes the gate eligible, and calling
 * `getRateLimitProbeAdmission` once takes the single-flight lease, standing in
 * for a concurrent request that is already probing.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	getRateLimitProbeAdmission,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

/**
 * `openai-compatible` with an api_key: the Anthropic-shaped fixture has neither
 * token nor key and dies in TokenRefresh before the request is ever issued. No
 * `refresh_token`, so the all-accounts-failed `needsReauth` throw cannot claim
 * the request ahead of the branch under test.
 */
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "vision-test",
		provider: "openai-compatible",
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
		peak_hours_pause_enabled: false,
		custom_endpoint: "https://openrouter.ai/api/v1",
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

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-haiku",
		name: "haiku",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function makeContext(
	accounts: Account[],
	opts: { combo?: ComboWithSlots | null; sessionFallback?: boolean } = {},
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
			getComboSessionFallback: () => opts.sessionFallback ?? true,
			getStorePayloads: () => false,
		} as never,
		provider: { name: "codex", canHandle: () => true } as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

/** An image on the wire is what arms the vision classifier at all. */
function imageRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-haiku-4-5",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this" },
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

function visionRejection(): Response {
	return new Response(
		JSON.stringify({
			error: { message: "This model does not support image input." },
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/** An account whose cooldown just expired and whose probe lease is taken. */
function suppress(account: Account): Account {
	const suppressed = {
		...account,
		rate_limited_until: Date.now() - 1,
		rate_limited_reason: "upstream_529_overloaded_no_reset",
	};
	expect(getRateLimitProbeAdmission(suppressed)).toBe("admitted");
	return suppressed;
}

/**
 * Runs an image request and normalises the outcome. A permanent vision refusal
 * comes back as a Response; the retryable paths either return a pool envelope
 * or throw `ServiceUnavailableError` (the server maps that to a hard 503), so a
 * throw is recorded as a retryable 503 rather than let out of the test.
 */
async function runImageRequest(
	ctx: ProxyContext,
	upstream: () => Response = visionRejection,
) {
	const collectorSpy = stubUsageCollector();
	const realFetch = globalThis.fetch;
	globalThis.fetch = mock(async () => upstream()) as unknown as typeof fetch;
	try {
		const response = await handleProxy(
			imageRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const body = (await response.json()) as {
			error: { type: string; code?: string };
		};
		return {
			status: response.status,
			errorType: body.error?.type,
			code: body.error?.code,
			poolStatus: response.headers.get("x-better-ccflare-pool-status"),
			retryAfter: response.headers.get("Retry-After"),
			threw: false,
		};
	} catch (e) {
		const statusCode = (e as { statusCode?: number })?.statusCode;
		if (statusCode !== 503) throw e;
		return {
			status: 503,
			errorType: (e as Error).name,
			code: undefined,
			poolStatus: null,
			retryAfter: null,
			threw: true,
		};
	} finally {
		globalThis.fetch = realFetch;
		collectorSpy.mockRestore();
	}
}

describe("vision_unsupported — only permanent when every candidate was asked", () => {
	afterEach(() => {
		resetRateLimitProbeGatesForTests();
	});

	// Finding 1: `attempted` skips probe-suppressed candidates, so one rejection
	// plus one skip used to satisfy `visionRejections === attempted` and answer a
	// permanent 400 for an account that was merely mid-recovery.
	it("stays retryable when another candidate was probe-suppressed and never asked", async () => {
		const healthy = makeAccount({ id: "acc-1", name: "healthy" });
		const recovering = suppress(
			makeAccount({ id: "acc-2", name: "recovering", priority: 1 }),
		);

		const result = await runImageRequest(makeContext([healthy, recovering]));

		expect(result.errorType).not.toBe("vision_unsupported");
		expect(result.poolStatus).not.toBe("vision_unsupported");
		expect(result.status).toBe(503);
	});

	// Finding 2: the main loop's ungated retry (the one that fires when EVERY
	// candidate was suppressed) never touched the counters, so `attempted` stayed
	// 0 and the image-specific branch was skipped. With a sole candidate the
	// retry covers the whole pool, so the answer is genuinely permanent.
	it("counts the ungated retry, so a sole suppressed candidate answers 400", async () => {
		const sole = suppress(makeAccount({ id: "acc-1", name: "sole" }));

		const result = await runImageRequest(makeContext([sole]));

		expect(result.status).toBe(400);
		expect(result.errorType).toBe("vision_unsupported");
		expect(result.poolStatus).toBe("vision_unsupported");
		expect(result.retryAfter).toBeNull();
	});

	// The same block with two suppressed candidates must NOT claim permanence:
	// the ungated retry only covers the first, so the second was never asked.
	it("stays retryable when the ungated retry leaves other candidates untried", async () => {
		const one = suppress(makeAccount({ id: "acc-1", name: "one" }));
		const two = suppress(
			makeAccount({ id: "acc-2", name: "two", priority: 1 }),
		);

		const result = await runImageRequest(makeContext([one, two]));

		expect(result.errorType).not.toBe("vision_unsupported");
		expect(result.status).toBe(503);
	});

	// Finding 3: with Combo Session Fallback disabled the request returned the
	// retryable 503 before reaching the image branch, so an image no slot could
	// read looked like a transient outage.
	it("names the image cause even when combo session fallback is disabled", async () => {
		const accounts = [
			makeAccount({ id: "acc-1", name: "slot-one" }),
			makeAccount({ id: "acc-2", name: "slot-two", priority: 1 }),
		];
		const combo = makeCombo([
			{
				id: "slot-0",
				combo_id: "combo-haiku",
				account_id: "acc-1",
				model: "model-one",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-1",
				combo_id: "combo-haiku",
				account_id: "acc-2",
				model: "model-two",
				priority: 1,
				enabled: true,
			},
		]);

		const result = await runImageRequest(
			makeContext(accounts, { combo, sessionFallback: false }),
		);

		expect(result.status).toBe(400);
		expect(result.errorType).toBe("vision_unsupported");
		expect(result.code).not.toBe("combo_session_fallback_disabled");
	});

	// …but a combo slot that failed for another reason still gets the
	// config-level answer, so the reordering did not swallow it.
	it("still answers combo_session_fallback_disabled when the slots failed for another reason", async () => {
		const accounts = [makeAccount({ id: "acc-1", name: "slot-one" })];
		const combo = makeCombo([
			{
				id: "slot-0",
				combo_id: "combo-haiku",
				account_id: "acc-1",
				model: "model-one",
				priority: 0,
				enabled: true,
			},
		]);

		const result = await runImageRequest(
			makeContext(accounts, { combo, sessionFallback: false }),
			// A 401 makes proxyWithAccount fail over (return null) without
			// counting as anything else, which is the only way to reach the
			// combo-disabled branch — a model-not-found 400 answers the client
			// directly from the model-cycling path.
			() =>
				new Response(
					JSON.stringify({
						error: { type: "authentication_error", message: "invalid key" },
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		);

		expect(result.status).toBe(503);
	});
});
