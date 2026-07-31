import { describe, expect, it } from "bun:test";
import { hasRateLimitMetadata, isRetryable429 } from "../retryable-429";

/**
 * The real shape captured from Anthropic on 2026-07-31 for the windowless 429
 * this fix targets: an explicit retry instruction and NO rate-limit window
 * headers.
 *   {"x-robots-tag":"none","x-should-retry":"true"}
 */
function burst429(extra: Record<string, string> = {}): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limit exceeded" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-robots-tag": "none",
				"x-should-retry": "true",
				...extra,
			},
		},
	);
}

describe("hasRateLimitMetadata", () => {
	it("is false for the windowless shape, which carries no rate-limit header at all", () => {
		expect(hasRateLimitMetadata(burst429().headers)).toBe(false);
	});

	// The last four are the fail-closed half: none of them is a reset hint, and
	// none was on the old enumerated list, yet each one proves the response knows
	// something about a window. The prefix scan catches them by construction, so
	// a header name Anthropic invents tomorrow needs no change here.
	it.each([
		["retry-after", "60"],
		["anthropic-ratelimit-unified-reset", "1785438225"],
		["x-ratelimit-reset", "1785438225"],
		["anthropic-ratelimit-unified-5h-reset", "1785518400"],
		["anthropic-ratelimit-unified-5h-utilization", "1.01"],
		["anthropic-ratelimit-unified-status", "allowed"],
		["x-ratelimit-limit", "1000"],
	])("is true for %s", (name, value) => {
		expect(hasRateLimitMetadata(burst429({ [name]: value }).headers)).toBe(
			true,
		);
	});
});

describe("isRetryable429", () => {
	it("accepts the captured windowless-429 shape", () => {
		expect(isRetryable429(burst429(), true)).toBe(true);
	});

	it("rejects a non-429 status", () => {
		const res = new Response("{}", {
			status: 529,
			headers: { "x-should-retry": "true" },
		});
		expect(isRetryable429(res, true)).toBe(false);
	});

	it("rejects a non-Claude provider even for an identical response", () => {
		// Zai's parser deliberately returns no reset so response-processor can
		// read the real window from the JSON body. Calling that request-scoped
		// would leave an account in rotation against a genuine window limit.
		expect(isRetryable429(burst429(), false)).toBe(false);
	});

	it('rejects when x-should-retry is absent or not "true"', () => {
		const missing = new Response("{}", { status: 429 });
		expect(isRetryable429(missing, true)).toBe(false);
		const falsey = new Response("{}", {
			status: 429,
			headers: { "x-should-retry": "false" },
		});
		expect(isRetryable429(falsey, true)).toBe(false);
	});

	it("rejects when any reset hint is present", () => {
		expect(
			isRetryable429(
				burst429({ "anthropic-ratelimit-unified-reset": "1785438225" }),
				true,
			),
		).toBe(false);
		expect(isRetryable429(burst429({ "retry-after": "60" }), true)).toBe(false);
	});

	// THE fail-closed regression guard. Measured 429: `x-should-retry: true` plus
	// ONLY the per-window headers — `anthropic-ratelimit-unified-5h-status:
	// rejected`, `-5h-reset`, `-5h-utilization: 1.01` — and none of the aggregate
	// ones. A genuinely spent five-hour window. The old enumerated predicate
	// probed `anthropic-ratelimit-unified-reset` / `x-ratelimit-reset` /
	// `retry-after`, none of which is present here, so it called this windowless
	// and would have kept a spent account in rotation. The prefix scan declines it.
	it("rejects a windowed-only exhausted 429 with no aggregate headers", () => {
		expect(
			isRetryable429(
				burst429({
					"anthropic-ratelimit-unified-5h-status": "rejected",
					"anthropic-ratelimit-unified-5h-reset": "1785518400",
					"anthropic-ratelimit-unified-5h-utilization": "1.01",
				}),
				true,
			),
		).toBe(false);
	});

	// A bare `x-ratelimit-*` header that is not a reset: it says nothing about
	// when the limit lifts, but it proves the response carries window state, so
	// fail-closed declines it.
	it("rejects a bare x-ratelimit-limit header that is not a reset", () => {
		expect(
			isRetryable429(burst429({ "x-ratelimit-limit": "1000" }), true),
		).toBe(false);
	});

	// These now fail the metadata scan before the status is ever inspected — the
	// header name alone is disqualifying. The expectation is unchanged; what
	// guards it moved, and ACCOUNT_WIDE_UNIFIED_STATUSES is defence in depth.
	it.each([
		"blocked",
		"queueing_hard",
		"payment_required",
		"rejected",
	])("rejects hard unified status %s", (status) => {
		expect(
			isRetryable429(
				burst429({ "anthropic-ratelimit-unified-status": status }),
				true,
			),
		).toBe(false);
	});

	// Deliberately flipped when the predicate became fail-closed. It previously
	// asserted `true` here, on the reasoning that a `rate_limited` status with no
	// reset hint is indistinguishable from the windowless shape. It is not
	// indistinguishable: the windowless shape carries no `anthropic-ratelimit-`
	// header whatsoever, so the presence of a unified status is itself the
	// difference. Leaving an account in rotation for a window Anthropic has
	// already named `rate_limited` is exactly the hole a previous review flagged
	// as unexplained.
	it("rejects unified status rate_limited even with no reset hint", () => {
		expect(
			isRetryable429(
				burst429({ "anthropic-ratelimit-unified-status": "rate_limited" }),
				true,
			),
		).toBe(false);
	});

	it("rejects out_of_credits even though it also sets x-should-retry true", () => {
		// The repo's own #261 fixture sets x-should-retry: "true", so the retry
		// instruction alone cannot exclude this model-scoped case. The metadata
		// scan is what fires first now — the reason header is
		// `anthropic-ratelimit-unified-overage-disabled-reason` — with the explicit
		// isAnthropicOutOfCredits guard behind it stating the intent.
		expect(
			isRetryable429(
				burst429({
					"anthropic-ratelimit-unified-overage-disabled-reason":
						"out_of_credits",
				}),
				true,
			),
		).toBe(false);
	});

	it("declines the real captured exhausted-window 429 (measured, verbatim)", () => {
		// Captured from Anthropic on the live installation 44 minutes after the
		// windowless 429 above, on the SAME account: a genuinely spent five-hour
		// window (utilization 1.01, unified status `rejected`, retry-after
		// 7835s) that STILL sets x-should-retry: true. Calling this
		// request-scoped would keep a spent account in rotation, so this is the
		// characterization test for the whole file. `hasRateLimitMetadata`
		// declines it on the first `anthropic-ratelimit-` header it reaches; the
		// `rejected` unified status and the `retry-after` would each have
		// declined it too. Note overage-disabled-reason here is
		// `org_level_disabled`, NOT `out_of_credits`.
		const res = new Response(
			JSON.stringify({
				type: "error",
				error: { type: "rate_limit_error", message: "rate limit exceeded" },
			}),
			{
				status: 429,
				headers: {
					"anthropic-ratelimit-unified-5h-reset": "1785518400",
					"anthropic-ratelimit-unified-5h-status": "rejected",
					"anthropic-ratelimit-unified-5h-surpassed-threshold": "1.0",
					"anthropic-ratelimit-unified-5h-utilization": "1.01",
					"anthropic-ratelimit-unified-7d-reset": "1786006800",
					"anthropic-ratelimit-unified-7d-status": "allowed",
					"anthropic-ratelimit-unified-7d-utilization": "0.69",
					"anthropic-ratelimit-unified-fallback-percentage": "0.5",
					"anthropic-ratelimit-unified-overage-disabled-reason":
						"org_level_disabled",
					"anthropic-ratelimit-unified-overage-status": "rejected",
					"anthropic-ratelimit-unified-representative-claim": "five_hour",
					"anthropic-ratelimit-unified-reset": "1785518400",
					"anthropic-ratelimit-unified-status": "rejected",
					"retry-after": "7835",
					"x-robots-tag": "none",
					"x-should-retry": "true",
				},
			},
		);
		expect(isRetryable429(res, true)).toBe(false);
	});

	it("does not consume the response body", async () => {
		const res = burst429();
		isRetryable429(res, true);
		expect(res.bodyUsed).toBe(false);
		await expect(res.json()).resolves.toBeDefined();
	});
});
