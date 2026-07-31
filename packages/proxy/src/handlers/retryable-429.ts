import { isAnthropicOutOfCredits } from "@better-ccflare/providers";

/**
 * Identifies a 429 whose scope is narrower than the account, so the caller can
 * fail the request over while leaving the account in rotation instead of
 * benching it.
 *
 * THE NAME IS HISTORICAL. `isRetryable429` was written when this module gated
 * an in-place retry of the same request against the same account. That retry is
 * gone — measurement showed the rejection does not clear within a request's
 * lifetime (three attempts spanning 11.2s returned three identical bare 429s) —
 * but the predicate turned out to be exactly the right discriminator for "this
 * rejection is not the account's fault", and it is pinned by 23 tests, so the
 * exported names are left alone. Nothing in here retries anything: a `true`
 * result means "fail over with NO account cooldown".
 */

/**
 * Header-name prefixes under which Anthropic reports rate-limit state — window
 * status, utilization, reset, overage, remaining, anything.
 *
 * The check that uses these is a PREFIX SCAN over the response's actual header
 * names, not a probe of known names, and that is the whole point. Enumerating
 * names is fail-open: a real exhausted-window 429 was measured carrying ONLY the
 * per-window headers (`anthropic-ratelimit-unified-5h-status: rejected`,
 * `-5h-reset`, `-5h-utilization: 1.01`) with none of the aggregate ones, so a
 * predicate that probed `anthropic-ratelimit-unified-reset` classified a
 * genuinely spent window as windowless — it would have left an account in
 * rotation whose five-hour window was already over budget. Safety must not rest
 * on Anthropic happening to send the aggregate headers alongside the windowed
 * ones — they control that header set and can change it without telling us.
 * Scanning by prefix declines every present and future window shape
 * automatically.
 *
 * `retry-after` is checked separately: it carries no prefix.
 */
const RATE_LIMIT_HEADER_PREFIXES = [
	"anthropic-ratelimit-",
	"x-ratelimit-",
] as const;

/**
 * Unified statuses that are account-wide or a billing block, and therefore the
 * opposite of what this module looks for: a hard block or a payment problem is
 * not narrower than the account, so the account must still be benched.
 *
 * NOTE ON WHAT ACTUALLY GUARDS THESE: nothing here is reachable today. Any
 * response carrying `anthropic-ratelimit-unified-status` at all is already
 * declined by `hasRateLimitMetadata`, which runs first and does not care what
 * the status says. This set is kept purely as defence in depth and as
 * self-documentation of intent — if the metadata scan is ever narrowed, these
 * four statuses stay declined.
 *
 * Derivation: AnthropicProvider's HARD_LIMIT_STATUSES
 * (providers/anthropic/provider.ts:14-19) plus `rejected`, which was measured on
 * a real exhausted-window 429 (five-hour utilization 1.01,
 * `anthropic-ratelimit-unified-5h-status: rejected`) that ALSO carried
 * `x-should-retry: true` — proof that the retry instruction alone can never
 * discriminate a request-scoped rejection from a genuinely spent window.
 * `rejected` is absent from that provider's own set, so this is the only place
 * it is named.
 *
 * `rate_limited` is not listed and does not need to be: as of the fail-closed
 * scan, a `rate_limited` unified status is declined by the metadata check like
 * every other unified status, reset hint or not.
 */
const ACCOUNT_WIDE_UNIFIED_STATUSES = new Set([
	"blocked",
	"queueing_hard",
	"payment_required",
	"rejected",
]);

/**
 * True when the response carries ANY rate-limit metadata — a `retry-after`, or
 * any header whose name starts with `anthropic-ratelimit-` or `x-ratelimit-`.
 *
 * Fail-closed by construction: it iterates the response's own header names
 * instead of probing a fixed list, so a window shape we have never seen is
 * declined without this file being updated. The windowless 429 this module
 * exists to identify carries none of these headers, so it still qualifies.
 *
 * Detection is header-based on purpose: AnthropicProvider.parseRateLimit
 * FABRICATES `resetTime = now + 60_000` for a bare 429 — see
 * `DEFAULT_429_COOLDOWN_MS` in providers/anthropic/provider.ts — so a
 * `!resetTime` test is false for precisely the responses this module exists to
 * identify.
 */
export function hasRateLimitMetadata(headers: Headers): boolean {
	if (headers.get("retry-after") !== null) return true;
	for (const name of headers.keys()) {
		const lower = name.toLowerCase();
		for (const prefix of RATE_LIMIT_HEADER_PREFIXES) {
			if (lower.startsWith(prefix)) return true;
		}
	}
	return false;
}

/**
 * True when a 429 reports no rate-limit window at all, which measurement showed
 * to mean the rejection is scoped to the request rather than to the account —
 * so the account must NOT be benched.
 *
 * Observed 2026-07-31 (issue #301): Anthropic 429s some requests with exactly
 * `{"x-robots-tag":"none","x-should-retry":"true"}` — an explicit retry
 * instruction and no rate-limit metadata of any kind — while the same account
 * keeps serving other requests on the same model seconds either side of the
 * rejection. Header-only and synchronous, so the caller needs no clone.
 *
 * The condition is deliberately asymmetric: the explicit upstream instruction
 * PLUS a total absence of rate-limit metadata. Anything that hints at a window —
 * known header name or not — is declined, and the caller benches as before.
 */
export function isRetryable429(
	response: Response,
	isClaudeProvider: boolean,
): boolean {
	if (response.status !== 429) return false;
	// Gate to Anthropic/Claude-OAuth: other providers' parsers have their own
	// reset conventions (Zai reads the window from the body downstream).
	if (!isClaudeProvider) return false;
	// Require the explicit upstream instruction rather than inferring it.
	if (response.headers.get("x-should-retry") !== "true") return false;
	// The load-bearing guard, and the first one that fires for every window
	// shape: any rate-limit metadata at all means the response DOES report a
	// window, so the limit is the account's and the account must be benched.
	if (hasRateLimitMetadata(response.headers)) return false;
	// Unreachable while the scan above stands (an `anthropic-ratelimit-`
	// prefixed header is exactly what it declines) — kept as defence in depth.
	const unified = response.headers.get("anthropic-ratelimit-unified-status");
	if (unified && ACCOUNT_WIDE_UNIFIED_STATUSES.has(unified)) return false;
	// Model/beta-scoped credit depletion (issue #261) also sets
	// x-should-retry: true, but it has its own handler earlier in the failover
	// path which records `out_of_credits` as the audit reason; claiming it here
	// would steal that reason and its family-exhaustion bookkeeping. Also
	// unreachable today: the reason header it reads is
	// `anthropic-ratelimit-unified-overage-disabled-reason`, which the scan above
	// already declines. Kept because it states the intent independently of header
	// naming, and it does not depend on ordering.
	if (isAnthropicOutOfCredits(response)) return false;
	return true;
}
