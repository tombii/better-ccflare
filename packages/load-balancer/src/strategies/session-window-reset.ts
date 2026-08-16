import { type Account, PROVIDER_NAMES } from "@better-ccflare/types";

/** Clock-skew buffer, matching the other window-reset checks in this folder. */
const RATE_LIMIT_RESET_BUFFER_MS = 1000;

/**
 * True when the upstream usage window a Codex session was riding has already
 * reset, which makes the locally tracked session stale regardless of how much
 * of `sessionDurationMs` is left on the clock.
 *
 * Why Codex needs this at all: session tracking anchors `session_start` to the
 * first request that goes through this proxy, while a Codex account's real 5h
 * window starts at the account's first request *anywhere* (Codex CLI, ChatGPT,
 * another proxy). When those two differ — and after a restart they almost
 * always do — the fixed 5h clock runs past the real reset, so traffic stays
 * pinned to the account that just rolled over instead of being re-selected
 * with the fresh capacity in view.
 *
 * `rate_limit_reset` is the right signal for Codex specifically because
 * response-processor rewrites it from the `x-codex-*` usage headers on every
 * response, so a value in the past means "the window I was riding closed", not
 * "this account was throttled once, some time ago".
 *
 * Deliberately NOT covered here:
 *
 *   - `anthropic` — already invalidates its session on a past
 *     `rate_limit_reset` inside resetSessionIfExpired. Whether an Anthropic
 *     session should also stop counting as *active* is a separate question
 *     with its own routing consequences, left untouched.
 *   - `zai` — `rate_limit_reset` is only written when a request actually gets
 *     rate-limited (see providers/zai/provider.ts parseRateLimit), so a past
 *     value carries no information about the current window.
 */
export function codexWindowHasReset(account: Account, now: number): boolean {
	if (account.provider !== PROVIDER_NAMES.CODEX) return false;

	const reset = account.rate_limit_reset;
	if (reset == null || reset >= now - RATE_LIMIT_RESET_BUFFER_MS) return false;

	// Only a boundary the session actually crossed counts. A reset older than
	// `session_start` belongs to a window that had already closed when the
	// session began — stale telemetry, not a rollover. Without this guard, a
	// Codex account whose responses stop carrying usage headers would keep its
	// stale reset forever and never be allowed to hold a session.
	return account.session_start !== null && account.session_start < reset;
}
