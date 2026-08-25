import {
	authFailureEvents,
	registerDisposable,
	ServiceUnavailableError,
	TokenRefreshError,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	getProvider,
	type TokenRefreshResult,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { TOKEN_REFRESH_BACKOFF_MS, TOKEN_SAFETY_WINDOW_MS } from "../constants";
import {
	clearPendingRotation,
	flushPendingRotation,
	getPendingRotation,
	recordPendingRotation,
} from "./pending-rotation-registry";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import {
	checkRefreshTokenHealth,
	getOAuthErrorMessage,
} from "./token-health-monitor";

const log = new Logger("TokenManager");

// Track refresh failures for backoff with TTL cleanup
const refreshFailures = new Map<string, number>();
// Track consecutive backoff hits per account
const backoffCounters = new Map<string, number>();
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FAILURE_RECORDS = 1000; // Prevent unbounded growth
const MAX_BACKOFF_RETRIES = 10; // After 10 backoff hits, check DB

// Cleanup old failures periodically
let cleanupInterval: Timer | null = null;

export const startTokenCleanupInterval = () => {
	if (!cleanupInterval) {
		cleanupInterval = setInterval(() => {
			const now = Date.now();
			const toDelete: string[] = [];

			for (const [accountId, failureTime] of refreshFailures.entries()) {
				if (now - failureTime > FAILURE_TTL_MS) {
					toDelete.push(accountId);
				}
			}

			// Clean up both maps together
			toDelete.forEach((accountId) => {
				refreshFailures.delete(accountId);
				backoffCounters.delete(accountId);
			});

			// Enforce size limit during periodic cleanup to prevent memory bloat
			enforceMaxSize();

			if (toDelete.length > 0) {
				log.debug(`Cleaned up ${toDelete.length} expired failure records`);
			}
		}, FAILURE_TTL_MS / 10); // Run cleanup more frequently (every 30 seconds)
	}
};

export const stopTokenCleanupInterval = () => {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
};

// Start cleanup interval and register for shutdown
startTokenCleanupInterval();

// Register cleanup as disposable for proper shutdown
registerDisposable({
	dispose: () => {
		stopTokenCleanupInterval();
		refreshFailures.clear();
		backoffCounters.clear();
	},
});

/**
 * Helper function to clean expired entries from refreshFailures Map
 */
function cleanupExpiredFailures(): void {
	const now = Date.now();
	const toDelete: string[] = [];

	for (const [accountId, failureTime] of refreshFailures.entries()) {
		if (now - failureTime > FAILURE_TTL_MS) {
			toDelete.push(accountId);
		}
	}

	toDelete.forEach((accountId) => {
		refreshFailures.delete(accountId);
		backoffCounters.delete(accountId); // Also clean up backoff counters
	});

	if (toDelete.length > 0) {
		log.debug(
			`Cleaned up ${toDelete.length} expired failure records during proactive cleanup`,
		);
	}
}

/**
 * Helper function to enforce maximum size limit on refreshFailures Map
 */
function enforceMaxSize(): void {
	if (refreshFailures.size > MAX_FAILURE_RECORDS) {
		// Remove oldest entries if we exceed the max size
		const _now = Date.now();
		const entries = Array.from(refreshFailures.entries()).sort(
			(a, b) => a[1] - b[1], // Sort by timestamp (oldest first)
		);

		const toRemove = entries.slice(
			0,
			refreshFailures.size - MAX_FAILURE_RECORDS + 1,
		);
		for (const [accountId] of toRemove) {
			refreshFailures.delete(accountId);
			backoffCounters.delete(accountId); // Also clean up backoff counters
		}

		if (toRemove.length > 0) {
			log.warn(
				`Removed ${toRemove.length} oldest failure records to maintain max size limit`,
			);
		}
	}
}

/**
 * Definitive dead-refresh-token signals. Providers preserve the machine-readable
 * OAuth error code verbatim in their thrown message (invalid_grant /
 * invalid_refresh_token from the RFC-6749 grant flow, refresh_token_reused from
 * Codex's rotating-token reuse guard). Only these are definitive; transient
 * failures (network / 5xx / timeout) never carry them, so a false positive that
 * pulls the account from routing until a manual re-auth cannot occur from them.
 */
const DEFINITIVE_AUTH_FAILURE_RE =
	/invalid_grant|invalid_refresh_token|refresh_token_reused/i;

/**
 * Remove the "account <name>" framing from a provider refresh error before
 * scanning it for auth-failure codes.
 *
 * Every provider frames the account as `... for account ${account.name}: <rest>`
 * (Codex additionally repeats it in a `--reauthenticate ${account.name}` hint).
 * The account NAME is free-form user input, so an account literally named e.g.
 * "test_invalid_grant" would otherwise trip detection on ANY unrelated failure
 * and be pulled from routing. Anchoring the removal on the literal "account "
 * keyword means only the framed name is stripped and never the machine error
 * code in <rest> — so a real invalid_grant for an account named "grant" still
 * matches (no false negatives on the code itself), while the name can never
 * fabricate a match (no false positives from the name).
 */
function stripAccountFraming(message: string, accountName: string): string {
	if (!accountName) return message;
	return message.split(`account ${accountName}`).join("account");
}

/**
 * Isolate the OAuth `error` code portion of a provider refresh-error message,
 * excluding the free-form `error_description` text.
 *
 * Every provider constructs its thrown message as a static framing prefix
 * (`... for account: `) followed by `[errorObj.error, errorObj.error_description]
 * .filter(Boolean).join(": ")` (xAI additionally inserts the HTTP status before
 * the code, e.g. `"401 invalid_grant: ..."`; Codex's rotating-token special case
 * appends free text after `" - "` instead of `": "`). In every shape the code
 * lives in the segment between the FIRST and SECOND `": "` separators — the
 * first separator closes the static framing prefix, and the second (if any)
 * opens the human-readable description. Scanning only that middle segment
 * means a non-conformant `error_description` can never fabricate a match by
 * merely containing a code-like substring, while a real code is always found
 * (it never contains ": " itself — RFC 6749 error codes are bare identifiers).
 * Falls back to the whole (stripped) message when the expected `": "` framing
 * isn't present, so unanticipated message shapes are still scanned rather than
 * silently skipped (no new false negatives from the narrowing itself).
 */
function extractCodeSegment(message: string, accountName: string): string {
	const stripped = stripAccountFraming(message, accountName);
	const firstSep = stripped.indexOf(": ");
	if (firstSep === -1) return stripped;
	const afterFraming = stripped.slice(firstSep + 2);
	const secondSep = afterFraming.indexOf(": ");
	return secondSep === -1 ? afterFraming : afterFraming.slice(0, secondSep);
}

/**
 * True when a raw provider refresh-error message carries a definitive
 * dead-refresh-token signal. Scoped to just the OAuth error-code segment (see
 * {@link extractCodeSegment}) so a non-conformant server's `error_description`
 * text cannot trigger a false match. Exported for direct unit testing.
 */
export function isDefinitiveAuthFailure(
	message: string,
	accountName: string,
): boolean {
	return DEFINITIVE_AUTH_FAILURE_RE.test(
		extractCodeSegment(message, accountName),
	);
}

/**
 * Returns the matched definitive-auth-failure code (normalized to lower-case,
 * e.g. "invalid_grant") or null when the message is not a definitive failure.
 * Same code-segment scoping as {@link isDefinitiveAuthFailure}; used to tag
 * the emitted auth-failure alert event with a stable, machine-readable reason.
 */
export function extractAuthFailureReason(
	message: string,
	accountName: string,
): string | null {
	const match = DEFINITIVE_AUTH_FAILURE_RE.exec(
		extractCodeSegment(message, accountName),
	);
	return match ? match[0].toLowerCase() : null;
}

/**
 * Re-reads the account row from the database and adopts fresher credentials
 * than the caller's in-memory snapshot. The auto-refresh scheduler (and any
 * long-lived caller) hands us an account object built from a loop-start
 * SELECT; if another consumer rotated the tokens since, refreshing with the
 * snapshot's consumed refresh token yields a definitive-looking invalid_grant
 * that would falsely flag a healthy account for re-auth.
 *
 * Returns the adopted access token when the DB row holds one valid beyond
 * TOKEN_SAFETY_WINDOW_MS (caller must skip the refresh), otherwise null —
 * after syncing a rotated refresh_token/refresh_token_issued_at into the
 * snapshot so any refresh that still happens uses the live token.
 */
async function adoptDbTokensIfFresher(
	account: Account,
	ctx: ProxyContext,
): Promise<string | null> {
	// (round-3 item 1) A pending unpersisted rotation outranks anything the DB
	// says: flush it first, and — if the flush landed ("persisted") or is
	// still failing ("failed") — serve/use its credentials rather than
	// replaying the consumed token from a stale row. Captured BEFORE the
	// flush call: a successful flush clears the registry entry immediately,
	// so the data must be read out while it still exists. A "superseded"
	// flush means the DB already moved past the attempted token (a manual
	// re-auth or a newer rotation landed first) — that pending data is no
	// longer authoritative, so it is deliberately NOT served in that case.
	const pendingRotation = getPendingRotation(account.id);
	const flush = await flushPendingRotation(account.id, ctx.dbOps);
	// An entry re-recorded for this account while the flush above was still
	// awaiting its CAS write (e.g. a concurrent request-triggered refresh
	// whose own persist also failed) outranks the pre-flush snapshot — it is
	// strictly newer, so serve/adopt it instead of the stale `pendingRotation`
	// captured before the flush.
	const effectivePending = getPendingRotation(account.id) ?? pendingRotation;
	if (effectivePending && (flush === "failed" || flush === "persisted")) {
		account.access_token = effectivePending.accessToken;
		account.expires_at = effectivePending.expiresAt;
		if (effectivePending.refreshToken) {
			account.refresh_token = effectivePending.refreshToken;
		}
		if (effectivePending.expiresAt - Date.now() > TOKEN_SAFETY_WINDOW_MS) {
			log.warn(
				`Serving rotated token for account ${account.name} from the pending-rotation registry (flush=${flush})`,
			);
			return account.access_token;
		}
		// expired pending: fall through — the refresh below now uses the
		// rotated refresh token instead of the consumed one.
	}

	let dbAccount: Account | null = null;
	try {
		dbAccount = await ctx.dbOps.getAccount(account.id);
	} catch (error) {
		log.warn(
			`Failed to re-read account ${account.name} before refresh — proceeding with in-memory snapshot`,
			error,
		);
		return null;
	}
	if (!dbAccount) return null;

	const dbTokenValid =
		typeof dbAccount.access_token === "string" &&
		typeof dbAccount.expires_at === "number" &&
		dbAccount.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS;

	// (round-3 item 3) Hoisted so the adoption branch below and the
	// standalone RT-sync branch share the SAME staleness guard. A DB row
	// that predates issued-at tracking (dbIssuedAt === null) is never
	// trusted over a snapshot that DOES have an issued-at, since we cannot
	// tell whether the untracked DB write happened before or after it.
	const dbIssuedAt = dbAccount.refresh_token_issued_at ?? null;
	const memIssuedAt = account.refresh_token_issued_at ?? null;
	const dbRefreshTokenNotOlder =
		memIssuedAt === null || (dbIssuedAt !== null && dbIssuedAt >= memIssuedAt);

	// (finding 6) Adopt on strictly-newer expiry (monotonic), not on string
	// inequality — a delayed DB read must never look "different, therefore
	// fresher": two access tokens minted moments apart can differ as strings
	// while the DB's is actually the OLDER of the two.
	if (dbTokenValid && (dbAccount.expires_at ?? 0) > (account.expires_at ?? 0)) {
		account.access_token = dbAccount.access_token;
		account.expires_at = dbAccount.expires_at;
		// (round-3 item 3) A newer access token does not imply a newer
		// refresh token: never regress account.refresh_token to an older one
		// merely because the DB row happens to carry some (possibly stale)
		// value alongside the fresher access token.
		if (dbAccount.refresh_token && dbRefreshTokenNotOlder) {
			account.refresh_token = dbAccount.refresh_token;
			account.refresh_token_issued_at = dbAccount.refresh_token_issued_at;
		}
		refreshFailures.delete(account.id);
		backoffCounters.delete(account.id);
		log.info(
			`Adopted fresher tokens from DB for account ${account.name} — skipping refresh`,
		);
		return dbAccount.access_token;
	}

	// (finding 6) Sync a rotated refresh token only when the DB's is not
	// provably older than the in-memory snapshot's.
	if (
		dbAccount.refresh_token &&
		dbAccount.refresh_token !== account.refresh_token &&
		dbRefreshTokenNotOlder
	) {
		account.refresh_token = dbAccount.refresh_token;
		account.refresh_token_issued_at = dbAccount.refresh_token_issued_at;
		log.info(
			`Adopted rotated refresh token from DB for account ${account.name} before refreshing`,
		);
	}
	return null;
}

/**
 * Safely refreshes an access token with deduplication
 * @param account - The account to refresh token for
 * @param ctx - The proxy context
 * @returns Promise resolving to the new access token
 * @throws {TokenRefreshError} If token refresh fails
 * @throws {ServiceUnavailableError} If refresh promise is not found
 */
export async function refreshAccessTokenSafe(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// (finding 5) Join an in-flight refresh FIRST — before backoff — so a
	// concurrent caller shares the outcome instead of failing on a backoff
	// seeded by an earlier, unrelated failure (e.g. the auto-refresh
	// scheduler registers its own in-flight promise into this same map;
	// a request-triggered caller must join that refresh, not bounce off a
	// stale backoff record for the account).
	const inFlight = ctx.refreshInFlight.get(account.id);
	if (inFlight) return inFlight;

	// Proactively clean expired entries before checking
	cleanupExpiredFailures();

	// Check for recent refresh failures and implement backoff
	const lastFailure = refreshFailures.get(account.id);
	if (lastFailure && Date.now() - lastFailure < TOKEN_REFRESH_BACKOFF_MS) {
		// Increment backoff counter
		const currentCount = backoffCounters.get(account.id) || 0;
		const newCount = currentCount + 1;
		backoffCounters.set(account.id, newCount);

		log.warn(
			`Account ${account.name} is in refresh backoff period (attempt ${newCount})`,
		);

		// After MAX_BACKOFF_RETRIES consecutive backoff hits, check DB for updated tokens
		if (newCount >= MAX_BACKOFF_RETRIES) {
			log.info(
				`Account ${account.name} has hit ${newCount} backoff attempts, checking DB for updated tokens`,
			);

			try {
				// Reload account from database
				const dbAccount = await ctx.dbOps.getAccount(account.id);
				if (dbAccount) {
					// Check if DB has a valid token that we don't have in memory
					const accessTokenFromDb = dbAccount.access_token;
					const expiresAtFromDb = dbAccount.expires_at;
					const hasValidToken =
						typeof accessTokenFromDb === "string" &&
						typeof expiresAtFromDb === "number" &&
						expiresAtFromDb - Date.now() > TOKEN_SAFETY_WINDOW_MS;

					if (hasValidToken && accessTokenFromDb !== account.access_token) {
						log.info(
							`Found updated token in DB for account ${account.name}, updating in-memory account`,
						);

						// Update in-memory account with DB data
						account.access_token = accessTokenFromDb;
						account.expires_at = expiresAtFromDb;
						if (dbAccount.refresh_token) {
							account.refresh_token = dbAccount.refresh_token;
						}
						account.last_used = Date.now();

						// Clear failure records and backoff counter
						refreshFailures.delete(account.id);
						backoffCounters.delete(account.id);

						log.info(
							`Successfully recovered token for account ${account.name} from DB`,
						);
						if (!dbAccount.access_token) {
							throw new TokenRefreshError(
								account.id,
								new Error("DB account has no access token"),
							);
						}
						return dbAccount.access_token;
					} else {
						log.warn(
							`DB token for account ${account.name} is not valid or same as in-memory`,
						);
					}
				} else {
					log.warn(
						`Account ${account.name} not found in DB during backoff recovery`,
					);
				}
			} catch (error) {
				log.error(
					`Failed to check DB for account ${account.name} during backoff recovery`,
					error,
				);
			}
		}

		throw new ServiceUnavailableError(
			`Token refresh for account ${account.name} is in backoff period after recent failure`,
		);
	} else {
		// Not in backoff, reset counter
		backoffCounters.delete(account.id);
	}

	// The caller's account object may be a stale snapshot (the auto-refresh
	// scheduler builds one from a loop-start SELECT). Re-read the row and adopt
	// fresher credentials before initiating a refresh — refreshing with an
	// already-rotated refresh token produces a false-definitive invalid_grant.
	if (!ctx.refreshInFlight.has(account.id)) {
		const adopted = await adoptDbTokensIfFresher(account, ctx);
		if (adopted) return adopted;
	}

	// Check if a refresh is already in progress for this account.
	// NOTE: no await may sit between this check and refreshInFlight.set() —
	// microtask atomicity is what deduplicates concurrent callers.
	if (!ctx.refreshInFlight.has(account.id)) {
		// Get the provider for this account
		const provider = getProvider(account.provider) || ctx.provider;

		// Captured for the rotation-race guard in the catch handler: if the DB's
		// refresh token differs from this one by the time the refresh fails, the
		// failure condemned a superseded token, not the account.
		const attemptedRefreshToken = account.refresh_token;

		// Create a new refresh promise and store it
		const refreshPromise = provider
			.refreshToken(account, ctx.runtime.clientId)
			.then(async (result: TokenRefreshResult) => {
				// (finding 1) Persist INSIDE the shared promise so refreshInFlight
				// stays installed until the write commits, and never via the
				// lossy asyncWriter queue (a queued write's failure was
				// previously unobservable to anyone awaiting this refresh).
				// (finding 4) CAS on the attempted refresh token so a refresh
				// that lost a race to a manual re-auth cannot overwrite newer
				// credentials with the stale ones it started with.
				// Set when the persist CAS loses to a manual re-auth or a newer
				// rotation and the authoritative DB row is adopted below — skips
				// the general in-memory update further down so the live
				// `account` object never installs the losing credentials.
				let adoptAuthoritative = false;
				// Token this call resolves with — defaults to the just-minted
				// (possibly losing) refresh result; overwritten below if the
				// adopted DB row's access token is itself servable, since the
				// losing token's session family may have been revoked by the
				// winning manual re-auth.
				let resolveWithToken = result.accessToken;
				try {
					let persisted: boolean;
					if (attemptedRefreshToken) {
						persisted =
							await ctx.dbOps.updateAccountTokensIfRefreshTokenMatches(
								account.id,
								attemptedRefreshToken,
								result.accessToken,
								result.expiresAt,
								result.refreshToken,
							);
					} else {
						// (round-3 item 4) Null-safe CAS: an account that refreshed
						// without a refresh token must not blind-overwrite
						// credentials a concurrent manual re-auth may have just
						// written.
						persisted = await ctx.dbOps.updateAccountTokensIfRefreshTokenAbsent(
							account.id,
							result.accessToken,
							result.expiresAt,
							result.refreshToken,
						);
					}
					if (persisted) {
						clearPendingRotation(account.id);
					} else {
						log.warn(
							`Skipped persisting refreshed tokens for ${account.name}: refresh token changed underneath (superseded by a newer rotation or manual re-auth) — adopting the authoritative DB credentials instead`,
						);
						try {
							const dbAccount = await ctx.dbOps.getAccount(account.id);
							if (dbAccount) {
								account.access_token = dbAccount.access_token;
								account.expires_at = dbAccount.expires_at;
								if (dbAccount.refresh_token) {
									account.refresh_token = dbAccount.refresh_token;
									account.refresh_token_issued_at =
										dbAccount.refresh_token_issued_at;
								}
								adoptAuthoritative = true;
								// The winning writer (manual re-auth or a newer rotation)
								// may have revoked the losing token's session family —
								// serve the adopted access token instead when it is
								// itself servable, so the caller isn't handed a token
								// that fails auth despite valid credentials sitting in
								// memory.
								const adoptedTokenIsServable =
									typeof dbAccount.access_token === "string" &&
									typeof dbAccount.expires_at === "number" &&
									dbAccount.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS;
								if (adoptedTokenIsServable && dbAccount.access_token) {
									resolveWithToken = dbAccount.access_token;
								}
								log.warn(
									`Persist CAS lost for ${account.name} — serving the ${adoptedTokenIsServable ? "adopted authoritative" : "just-minted (losing)"} access token`,
								);
							}
						} catch (readError) {
							log.warn(
								`Failed to re-read account ${account.name} after a lost persist CAS — falling back to the in-memory update`,
								readError,
							);
						}
					}
				} catch (persistError) {
					// (round-3 item 1) A rotation the provider has already
					// committed must never be silently dropped: the DB still
					// holds the consumed token, and a later stale consumer would
					// replay it, get invalid_grant, and CAS-flag a healthy
					// account. Record it so every subsequent touchpoint retries
					// the persist, serves the rotated credentials, and
					// suppresses flagging meanwhile.
					recordPendingRotation(account.id, {
						accessToken: result.accessToken,
						expiresAt: result.expiresAt,
						refreshToken: result.refreshToken,
						attemptedRefreshToken: attemptedRefreshToken ?? "",
					});
					log.error(
						`Failed to persist refreshed tokens for ${account.name} — rotation queued for re-persist`,
						persistError,
					);
				}

				// Update the live in-memory account object immediately
				// This prevents subsequent requests from seeing stale token data
				// — unless the persist-CAS-loss branch above already adopted the
				// authoritative DB row, in which case installing these (losing)
				// result values would overwrite it right back.
				if (!adoptAuthoritative) {
					account.access_token = result.accessToken;
					account.expires_at = result.expiresAt;
					if (result.refreshToken) {
						account.refresh_token = result.refreshToken;
					}
				}
				account.last_used = Date.now();

				// Clear any previous failure record on successful refresh
				refreshFailures.delete(account.id);

				const expiresInSec = Math.round((result.expiresAt - Date.now()) / 1000);
				log.info(`Successfully refreshed token for account: ${account.name}`);
				log.debug(`refresh for ${account.name}:`, {
					expiresInSec,
					newRefreshToken: result.refreshToken !== account.refresh_token,
					provider: account.provider,
				});
				return resolveWithToken;
			})
			.catch(async (error) => {
				// Record the failure timestamp for backoff
				refreshFailures.set(account.id, Date.now());
				// Enforce size limit after adding a new entry
				enforceMaxSize();

				const originalError =
					error instanceof Error ? error.message : String(error);
				const enhancedMessage = getOAuthErrorMessage(account, originalError);

				// Definitive dead-refresh-token signal (invalid_grant /
				// invalid_refresh_token / refresh_token_reused) — persist
				// requires_reauth so the account is pulled from routing until a manual
				// re-auth clears it. Detection runs on the RAW provider message (which
				// preserves the machine error code) here, BEFORE it is wrapped into
				// TokenRefreshError (whose .message is a fixed string). Transient failures
				// never match.
				const authFailureReason = extractAuthFailureReason(
					originalError,
					account.name,
				);
				if (authFailureReason) {
					// (round-3 item 1) A pending unpersisted rotation means WE
					// rotated successfully moments ago — this failure is a
					// replay of the consumed token, not a dead account.
					if (getPendingRotation(account.id)) {
						log.warn(
							`Skipping requires_reauth for ${account.name}: a successful rotation is awaiting persist (replayed a consumed token)`,
						);
						throw new TokenRefreshError(account.id, new Error(enhancedMessage));
					}
					// Rotation-race guard: a definitive rejection of a refresh token
					// that is no longer the account's current one means another
					// consumer rotated successfully after our snapshot was taken.
					// Recover from the DB instead of condemning a healthy account.
					let dbAccount: Account | null = null;
					let dbReadFailed = false;
					try {
						dbAccount = await ctx.dbOps.getAccount(account.id);
					} catch (readError) {
						dbReadFailed = true;
						log.warn(
							`Could not re-read account ${account.name} after ${authFailureReason} — leaving requires_reauth unset (unverified)`,
							readError,
						);
					}
					if (
						dbAccount?.refresh_token &&
						dbAccount.refresh_token !== attemptedRefreshToken
					) {
						account.refresh_token = dbAccount.refresh_token;
						account.refresh_token_issued_at = dbAccount.refresh_token_issued_at;
						const dbTokenValid =
							typeof dbAccount.access_token === "string" &&
							typeof dbAccount.expires_at === "number" &&
							dbAccount.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS;
						if (dbTokenValid && dbAccount.access_token) {
							account.access_token = dbAccount.access_token;
							account.expires_at = dbAccount.expires_at;
							refreshFailures.delete(account.id);
							backoffCounters.delete(account.id);
							log.warn(
								`Refresh for ${account.name} lost a rotation race (${authFailureReason} on a superseded token) — adopted current tokens from DB`,
							);
							return dbAccount.access_token;
						}
						log.warn(
							`Refresh for ${account.name} used a superseded refresh token (${authFailureReason}) — not flagging re-auth; the rotated token will be used after the refresh backoff`,
						);
						throw new TokenRefreshError(account.id, new Error(enhancedMessage));
					}
					// (finding 3) Unverifiable → do NOT flag; the backoff entry recorded
					// above already keeps this account out of routing for a while.
					if (dbReadFailed || !attemptedRefreshToken) {
						throw new TokenRefreshError(account.id, new Error(enhancedMessage));
					}
					// (finding 2) Atomic flag: only condemn the account if the DB still
					// holds the exact refresh token the provider just rejected — a CAS
					// write closes the gap between this read and the flag write itself.
					// Emit the auth-failure event only when the flag actually lands.
					try {
						const flagged = await ctx.dbOps.flagRequiresReauthIfTokenMatches(
							account.id,
							attemptedRefreshToken,
						);
						if (flagged) {
							authFailureEvents.emit("event", {
								accountId: account.id,
								accountName: account.name,
								provider: account.provider,
								reason: authFailureReason,
							});
						} else {
							log.warn(
								`Skipped requires_reauth for ${account.name}: refresh token rotated between verification and flag write (rotation race)`,
							);
						}
					} catch (flagError) {
						log.warn(
							`Could not persist requires_reauth for ${account.name} — leaving unset (unverified)`,
							flagError,
						);
					}
				}
				log.error(
					`Token refresh failed for account ${account.name}: ${enhancedMessage}`,
					error,
				);
				throw new TokenRefreshError(account.id, new Error(enhancedMessage));
			})
			.finally(() => {
				// (finding 4) Identity-safe: never delete a newer entry installed by
				// a manual reauth or cache-clear that ran while this promise was
				// still settling.
				if (ctx.refreshInFlight.get(account.id) === refreshPromise) {
					ctx.refreshInFlight.delete(account.id);
				}
			});
		ctx.refreshInFlight.set(account.id, refreshPromise);
	}

	// Return the existing or new refresh promise
	const promise = ctx.refreshInFlight.get(account.id);
	if (!promise) {
		throw new ServiceUnavailableError(
			`${ERROR_MESSAGES.REFRESH_NOT_FOUND} ${account.id}`,
		);
	}
	return promise;
}

// Global registry for account refresh clearing functions
const refreshClearers: Map<string, (accountId: string) => void> = new Map();

// Global registry for auto-refresh-scheduler tracking clearing functions
const autoRefreshTrackingClearers: Map<string, (accountId: string) => void> =
	new Map();

// Global registry for usage polling restart functions
const pollingRestarters: Map<string, (accountId: string) => Promise<boolean>> =
	new Map();

export interface CodexUsageRefreshOutcome {
	success: boolean;
	message: string;
}

// Global registry for codex on-demand usage refreshers (one per server)
const codexUsageRefreshers: Map<
	string,
	(accountId: string) => Promise<CodexUsageRefreshOutcome>
> = new Map();

// Per-account in-flight tracker so concurrent requests share a single fetch.
const codexUsageInflight: Map<
	string,
	Promise<CodexUsageRefreshOutcome>
> = new Map();

/**
 * Register a function to restart usage polling for a specific account.
 * Used by the server to expose its polling restart capability to HTTP handlers.
 */
export function registerPollingRestarter(
	serverId: string,
	restarter: (accountId: string) => Promise<boolean>,
): void {
	pollingRestarters.set(serverId, restarter);
}

/**
 * Unregister a previously registered polling restarter.
 */
export function unregisterPollingRestarter(serverId: string): void {
	pollingRestarters.delete(serverId);
}

/**
 * Restart usage polling for an account across all registered servers.
 * Returns true if at least one server successfully restarted polling.
 */
export async function restartUsagePollingForAccount(
	accountId: string,
): Promise<boolean> {
	let anySuccess = false;
	for (const [serverId, restarter] of pollingRestarters) {
		try {
			const ok = await restarter(accountId);
			if (ok) {
				anySuccess = true;
				log.info(
					`Restarted usage polling for account ${accountId} on server ${serverId}`,
				);
			}
		} catch (error) {
			log.error(
				`Failed to restart usage polling for account ${accountId} on server ${serverId}:`,
				error,
			);
		}
	}
	return anySuccess;
}

/**
 * Register a function that performs an on-demand codex usage refresh for a
 * given account. The server registers a callback that has access to its
 * proxy context so token refresh + DB updates can run via the normal path.
 */
export function registerCodexUsageRefresher(
	serverId: string,
	refresher: (accountId: string) => Promise<CodexUsageRefreshOutcome>,
): void {
	codexUsageRefreshers.set(serverId, refresher);
}

/**
 * Unregister a previously registered codex usage refresher.
 */
export function unregisterCodexUsageRefresher(serverId: string): void {
	codexUsageRefreshers.delete(serverId);
}

/**
 * Refresh codex usage data for an account by dispatching to a registered
 * server. Iterates serverId-keyed callbacks **sequentially** and returns the
 * first successful outcome — we never fan-out because every call costs a
 * real codex request. Concurrent callers for the same accountId share a
 * single in-flight promise.
 */
export async function refreshCodexUsageForAccount(
	accountId: string,
): Promise<CodexUsageRefreshOutcome> {
	const existing = codexUsageInflight.get(accountId);
	if (existing) {
		log.debug(`Reusing in-flight codex usage refresh for account ${accountId}`);
		return existing;
	}

	const promise = (async (): Promise<CodexUsageRefreshOutcome> => {
		if (codexUsageRefreshers.size === 0) {
			return {
				success: false,
				message: "No proxy server is registered to handle codex usage refresh.",
			};
		}

		let lastFailure: CodexUsageRefreshOutcome | null = null;
		for (const [serverId, refresher] of codexUsageRefreshers) {
			try {
				const result = await refresher(accountId);
				if (result.success) {
					log.info(
						`Refreshed codex usage for account ${accountId} via server ${serverId}`,
					);
					return result;
				}
				lastFailure = result;
			} catch (error) {
				log.error(
					`Codex usage refresh via server ${serverId} threw for account ${accountId}:`,
					error,
				);
				lastFailure = {
					success: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return (
			lastFailure ?? {
				success: false,
				message: "Codex usage refresh failed for unknown reasons.",
			}
		);
	})();

	codexUsageInflight.set(accountId, promise);
	promise.finally(() => {
		codexUsageInflight.delete(accountId);
	});
	return promise;
}

/**
 * Register a function to clear refresh cache for a specific account
 * Used by the server to register its refresh clearing capability
 */
export function registerRefreshClearer(
	serverId: string,
	clearer: (accountId: string) => void,
): void {
	refreshClearers.set(serverId, clearer);
}

/**
 * Unregister a previously registered refresh clearer.
 */
export function unregisterRefreshClearer(serverId: string): void {
	refreshClearers.delete(serverId);
}

/**
 * Clear refresh cache for an account across all registered servers
 */
export function clearAccountRefreshCache(accountId: string): void {
	for (const [serverId, clearer] of refreshClearers) {
		try {
			clearer(accountId);
			log.info(
				`Cleared refresh cache for account ${accountId} on server ${serverId}`,
			);
		} catch (error) {
			log.error(
				`Failed to clear refresh cache for account ${accountId} on server ${serverId}:`,
				error,
			);
		}
	}
}

/**
 * Register a function to clear auto-refresh-scheduler tracking state for a
 * specific account. Used by the server to expose its scheduler's per-account
 * cleanup so account removal doesn't have to wait for the scheduler's next
 * periodic sweep.
 */
export function registerAutoRefreshTrackingClearer(
	serverId: string,
	clearer: (accountId: string) => void,
): void {
	autoRefreshTrackingClearers.set(serverId, clearer);
}

/**
 * Unregister a previously registered auto-refresh tracking clearer.
 */
export function unregisterAutoRefreshTrackingClearer(serverId: string): void {
	autoRefreshTrackingClearers.delete(serverId);
}

/**
 * Clear auto-refresh-scheduler tracking state for an account across all
 * registered servers.
 */
export function clearAutoRefreshTrackingForAccount(accountId: string): void {
	for (const [serverId, clearer] of autoRefreshTrackingClearers) {
		try {
			clearer(accountId);
			log.info(
				`Cleared auto-refresh tracking for account ${accountId} on ${serverId}`,
			);
		} catch (error) {
			log.error(
				`Failed to clear auto-refresh tracking for account ${accountId} on ${serverId}:`,
				error,
			);
		}
	}
}

/**
 * Internal function to clear refresh cache with specific context
 * This is what the server registers as its clearer function
 */
function _clearAccountRefreshCacheWithContext(
	accountId: string,
	ctx: ProxyContext,
): void {
	// Clear any in-flight refresh for this account
	ctx.refreshInFlight.delete(accountId);

	// Clear refresh failure records and backoff
	refreshFailures.delete(accountId);
	backoffCounters.delete(accountId);

	log.info(`Cleared refresh cache for account ${accountId}`);
}

/**
 * Gets a valid access token for an account, refreshing if necessary
 * @param account - The account to get token for
 * @param ctx - The proxy context
 * @returns Promise resolving to a valid access token
 */
export async function getValidAccessToken(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// For API key providers, return the API key directly without OAuth token refresh logic
	if (
		account.provider === "openai-compatible" ||
		account.provider === "zai" ||
		account.provider === "claude-console-api" ||
		account.provider === "anthropic-compatible" ||
		account.provider === "minimax" ||
		account.provider === "deepseek"
	) {
		if (account.api_key) {
			return account.api_key;
		}
		throw new Error(`No API key available for account ${account.name}`);
	}

	// API key accounts don't use access tokens
	if (!account.refresh_token && account.api_key) {
		// Return empty string - the API key will be used in prepareHeaders
		return "";
	}

	// Check if token exists and won't expire within the safety window
	if (
		account.access_token &&
		account.expires_at &&
		account.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS
	) {
		return account.access_token;
	}

	// Check refresh token health before attempting refresh
	const tokenHealth = checkRefreshTokenHealth(account);

	// Log token health warnings for OAuth accounts
	if (tokenHealth.hasRefreshToken) {
		if (tokenHealth.status === "expired" || tokenHealth.status === "critical") {
			log.error(`🚨 ${tokenHealth.message}`);
		} else if (tokenHealth.status === "warning") {
			log.warn(`⚠️ ${tokenHealth.message}`);
		}
	}

	// Token is expired, missing, or will expire soon
	const reason = !account.access_token
		? "missing"
		: !account.expires_at
			? "no expiry"
			: account.expires_at <= Date.now()
				? "expired"
				: "expiring soon";

	log.info(`Token ${reason} for account: ${account.name}`);
	return await refreshAccessTokenSafe(account, ctx);
}
