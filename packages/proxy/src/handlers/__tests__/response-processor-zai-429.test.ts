import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getProvider } from "@better-ccflare/providers";
import { processProxyResponse } from "../response-processor";
import {
	isOrphaned,
	makeAccount,
	makeProxyContext,
	makeZai1308Fixture,
	recordClonesDuring,
	waitForCloneBodiesToSettle,
} from "./clone-leak-harness";

/**
 * S5 (spec TEST-SPEC.md §4) — the zai-429 body-reading branch in
 * `processProxyResponse` (response-processor.ts:272-295).
 *
 * This branch is integration-unreachable from `proxyWithAccount`: every
 * final 429 exits inside the `isModelUnavailableError` block before
 * `processProxyResponse` is ever called (F7 in the spec), and the 529→429
 * in-place-retry route does not exist for zai because `ZaiProvider.
 * parseRateLimit` returns `isRateLimited:false` for a 529. Testing this
 * through `proxyWithAccount` would therefore test a dead route —
 * `processProxyResponse` is exported and is the honest unit to drive
 * directly.
 *
 * Orphan assertion is RED-without-fix (the usage call-site clone was
 * orphaned pre-fix); assertions 1-4 below PIN pre-existing behaviour (they
 * hold on the pre-fix tree too) — see IMPL-REPORT.md for the recorded
 * red/green split.
 */
describe("processProxyResponse — zai 429 body-reading branch (S5)", () => {
	let savedBackoffBase: string | undefined;
	let savedBackoffMax: string | undefined;

	beforeEach(() => {
		savedBackoffBase = process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS;
		savedBackoffMax = process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS;
		// Guard against an ambient override shrinking the tier-1 429 backoff
		// below the fixture's ~20s reset delta — the assertion relies on the
		// default 30s tier-1 backoff being larger than that delta so
		// `min(resetTime, now+backoff)` picks the parsed resetTime.
		delete process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS;
		delete process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS;
	});

	afterEach(() => {
		if (savedBackoffBase === undefined) {
			delete process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS;
		} else {
			process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS = savedBackoffBase;
		}
		if (savedBackoffMax === undefined) {
			delete process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS;
		} else {
			process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS = savedBackoffMax;
		}
	});

	it("parses the reset time from the body, applies the with-reset cooldown, and leaves the body live and no clone orphaned", async () => {
		const zaiProvider = getProvider("zai");
		expect(zaiProvider).toBeDefined();
		if (!zaiProvider) throw new Error("zai provider not registered");

		const { resetUtcMs, body } = makeZai1308Fixture();
		const account = makeAccount({ provider: "zai", api_key: "test-key" });
		const ctx = makeProxyContext({ provider: zaiProvider });

		const response = new Response(body, {
			status: 429,
			headers: { "content-type": "application/json" },
			// Deliberately no retry-after — ZaiProvider.parseRateLimit then
			// yields {isRateLimited: true, resetTime: undefined}, which is what
			// makes processProxyResponse fall into the body-parsing branch.
		});

		const clones = await recordClonesDuring(async () => {
			const isRateLimited = await processProxyResponse(
				response,
				account,
				ctx,
				"req-1",
				{ headers: new Headers() },
			);
			expect(isRateLimited).toBe(true);
		});

		expect(account.rate_limited_reason).toBe("upstream_429_with_reset");
		expect(account.rate_limited_until).toBe(resetUtcMs);

		// The internal-clone read must not disturb the live, forwardable body.
		expect(response.bodyUsed).toBe(false);
		const parsedBody = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(parsedBody).toEqual(JSON.parse(body));

		await waitForCloneBodiesToSettle(clones);
		expect(clones.length).toBeGreaterThanOrEqual(2);
		expect(clones.filter(isOrphaned).length).toBe(0);
	});
});
