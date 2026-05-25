import { isAccountAvailable } from "@better-ccflare/core";
import { type Account, PROVIDER_NAMES } from "@better-ccflare/types";

const RATE_LIMIT_RESET_BUFFER_MS = 1000;

/**
 * Mirrors the auto-unpause condition that select() applies before testing
 * availability. Returns true when select() WOULD unpause this account on
 * its next call, without performing the unpause itself.
 *
 * Kept in sync with SessionStrategy.select() and
 * LeastUsedStrategy.autoUnpauseElapsedAccounts() — divergence here causes
 * peek() to flag the wrong account as Primary while real traffic goes
 * elsewhere.
 */
export function wouldAutoUnpause(
	account: Account,
	now: number = Date.now(),
): boolean {
	if (!account.paused) return false;
	if (!account.auto_fallback_enabled) return false;

	const supportsWindowReset =
		account.provider === PROVIDER_NAMES.ANTHROPIC ||
		account.provider === PROVIDER_NAMES.CODEX ||
		account.provider === PROVIDER_NAMES.ZAI;
	if (!supportsWindowReset) return false;

	const windowReset =
		account.rate_limit_reset != null &&
		account.rate_limit_reset < now - RATE_LIMIT_RESET_BUFFER_MS;
	if (!windowReset) return false;

	const pauseReason = account.pause_reason ?? null;
	return (
		pauseReason === null ||
		pauseReason === "overage" ||
		pauseReason === "rate_limit_window"
	);
}

/**
 * Side-effect-free availability check that includes the auto-unpause
 * simulation. Use in peek() so a paused-but-eligible account surfaces as
 * the would-be-primary instead of being skipped over because of its
 * stale `paused` flag.
 */
export function isPeekAvailable(
	account: Account,
	now: number = Date.now(),
): boolean {
	if (isAccountAvailable(account, now)) return true;
	if (!wouldAutoUnpause(account, now)) return false;
	// wouldAutoUnpause already validated the account is otherwise eligible
	// (paused with safe reason + auto-fallback + window elapsed). The only
	// remaining blocker isAccountAvailable would check is rate_limited_until,
	// which is independent of pause state.
	return !account.rate_limited_until || account.rate_limited_until < now;
}
