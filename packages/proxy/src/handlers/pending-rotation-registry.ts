import { Logger } from "@better-ccflare/logger";

const log = new Logger("PendingRotationRegistry");

/**
 * A refresh-token rotation that a provider call completed successfully but
 * whose DB persist failed (or hasn't been attempted yet). Kept in-process so
 * later touchpoints — the next refresh attempt, a request handler, a
 * background flush — can retry the persist, serve the rotated credentials in
 * the meantime, and avoid falsely flagging the account for re-auth.
 */
export type PendingRotation = {
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
	/** The refresh token the successful provider call consumed ("" when none). */
	attemptedRefreshToken: string;
	recordedAt: number;
};

/**
 * Narrow structural view of the DatabaseOperations CAS methods this registry
 * needs to flush a pending rotation. Declared here (not imported from the
 * class) so this module has no runtime dependency on @better-ccflare/database.
 */
export type PendingRotationDbOps = {
	updateAccountTokensIfRefreshTokenMatches(
		accountId: string,
		expectedRefreshToken: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	): Promise<boolean>;
	updateAccountTokensIfRefreshTokenAbsent(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	): Promise<boolean>;
};

// Safety valve against unbounded growth if persisting rotations stays broken
// for a long time — not a limit expected to matter in practice. Entries are
// small (~200 bytes each), so the cap can afford to be generous, and it
// should be: eviction here durably loses a provider-committed rotation (see
// the log.error below), so hitting this cap means 1000 accounts are
// simultaneously mid-rotation during a DB outage, which should be
// effectively unreachable.
const MAX_PENDING_ROTATIONS = 1000;
const pending = new Map<string, PendingRotation>();

/**
 * Records a rotation that a provider call completed but that has not (yet)
 * been durably persisted. Replaces any existing entry for the account.
 *
 * Anchor compression (round-3 final review, C1): if an entry already exists
 * for this account, the new rotation's `attemptedRefreshToken` is discarded
 * in favor of the existing entry's, and `recordedAt` is likewise carried
 * over instead of reset. An entry can only still be present here because
 * every flush attempt since it was recorded has failed — the DB never moved,
 * so its `attemptedRefreshToken` is still the token the DB actually holds.
 * A chain of rotations recorded while the DB is down (RT1→RT2, then RT2→RT3,
 * …) must keep CASing against RT1: RT2 was only ever consumed in-memory by
 * the provider call that produced the second (also-unpersisted) rotation,
 * and a flush keyed on RT2 would match 0 rows, get misread as "superseded",
 * and abandon the still-live RT1 anchor. (If the DB truly moved — a manual
 * re-auth — the anchored CAS simply returns 0 rows on the next flush and is
 * correctly classified "superseded" then.) Preserving `recordedAt` keeps
 * this replace's FIFO-eviction position consistent with a plain replace
 * instead of jumping the entry to the back of the eviction queue.
 *
 * Bounded to MAX_PENDING_ROTATIONS entries: if recording this rotation would
 * exceed the cap, the oldest entry (by insertion order) is evicted first. An
 * eviction means a rotation is durably lost — the account will lose its
 * refresh token entirely once the in-memory copy also ages out — so it is
 * logged as an error rather than silently dropped.
 */
export function recordPendingRotation(
	accountId: string,
	rotation: Omit<PendingRotation, "recordedAt">,
): void {
	if (!pending.has(accountId) && pending.size >= MAX_PENDING_ROTATIONS) {
		const oldestId = pending.keys().next().value;
		if (oldestId !== undefined) {
			pending.delete(oldestId);
			log.error(
				`Evicted pending rotation for account ${oldestId}: registry exceeded ${MAX_PENDING_ROTATIONS} entries — that rotation is now durably lost`,
			);
		}
	}
	const existing = pending.get(accountId);
	pending.set(accountId, {
		...rotation,
		attemptedRefreshToken: existing
			? existing.attemptedRefreshToken
			: rotation.attemptedRefreshToken,
		recordedAt: existing ? existing.recordedAt : Date.now(),
	});
}

/** Returns the pending rotation for the account, if any. */
export function getPendingRotation(
	accountId: string,
): PendingRotation | undefined {
	return pending.get(accountId);
}

/** Removes any pending rotation for the account. No-op if none exists. */
export function clearPendingRotation(accountId: string): void {
	pending.delete(accountId);
}

/** Test-only: clears the entire registry so tests don't leak state between runs. */
export function clearAllPendingRotationsForTests(): void {
	pending.clear();
}

/**
 * Attempts to persist a pending rotation for the account.
 * - "none": no entry for this account.
 * - "persisted": CAS landed; entry cleared — unless a newer rotation was
 *   recorded for this account while the CAS write was in flight, in which
 *   case that survivor is kept and its anchor is rebased onto the refresh
 *   token this flush just persisted (see below).
 * - "superseded": CAS matched 0 rows — the DB moved past the consumed token
 *   (manual re-auth or a newer rotation persisted); entry cleared, the DB is
 *   the source of truth now.
 * - "failed": the write threw; entry kept for the next flush attempt.
 *
 * Identity-guarded delete (round-3 final review, I2): both the "persisted"
 * and "superseded" branches only delete the entry that was actually flushed
 * — captured up front as `entry` — not whatever `pending.get(accountId)`
 * happens to return by the time the awaited CAS settles. A caller can
 * `recordPendingRotation` a newer rotation for this account while this
 * flush's CAS write is still in flight (a flapping DB, or a concurrent
 * request-triggered refresh); an unguarded delete would silently discard
 * that newer entry even though it was never flushed.
 *
 * Anchor rebase on a surviving entry (round-3, Codex concurrent
 * flush/re-record race): when the CAS lands but a newer entry survived the
 * identity guard above, that survivor's `attemptedRefreshToken` anchor was
 * compressed against the *pre-flush* DB state and no longer matches what the
 * DB now holds. Left alone, the survivor's own next flush would CAS against
 * a stale anchor, match 0 rows, get misread as "superseded", and be
 * discarded — even though it's the only in-memory copy of its refresh token.
 * Rebasing the anchor onto `entry.refreshToken` (what this CAS just wrote)
 * keeps the survivor's next flush aligned with reality.
 */
export async function flushPendingRotation(
	accountId: string,
	dbOps: PendingRotationDbOps,
): Promise<"none" | "persisted" | "superseded" | "failed"> {
	const entry = pending.get(accountId);
	if (!entry) return "none";

	try {
		const persisted = entry.attemptedRefreshToken
			? await dbOps.updateAccountTokensIfRefreshTokenMatches(
					accountId,
					entry.attemptedRefreshToken,
					entry.accessToken,
					entry.expiresAt,
					entry.refreshToken,
				)
			: await dbOps.updateAccountTokensIfRefreshTokenAbsent(
					accountId,
					entry.accessToken,
					entry.expiresAt,
					entry.refreshToken,
				);

		if (persisted) {
			const current = pending.get(accountId);
			if (current === entry) {
				pending.delete(accountId);
			} else if (current) {
				// A newer rotation was recorded while this flush's CAS write was
				// still in flight. The CAS we just landed moved the DB's refresh
				// token to entry.refreshToken (or left it at the anchor when the
				// rotation carried no new one) — rebase the survivor's anchor
				// onto that, so its own flush matches the DB instead of reading
				// 0 rows, getting misclassified "superseded", and discarding the
				// newest credentials.
				current.attemptedRefreshToken =
					entry.refreshToken ?? entry.attemptedRefreshToken;
			}
			return "persisted";
		}
		if (pending.get(accountId) === entry) pending.delete(accountId);
		log.warn(
			`Pending rotation for account ${accountId} was superseded — the DB moved past the consumed token (manual re-auth or a newer rotation)`,
		);
		return "superseded";
	} catch (error) {
		log.error(
			`Failed to flush pending rotation for account ${accountId} — keeping it for the next attempt`,
			error,
		);
		return "failed";
	}
}
