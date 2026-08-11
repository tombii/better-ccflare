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

const MAX_PENDING_ROTATIONS = 100;
const pending = new Map<string, PendingRotation>();

/**
 * Records a rotation that a provider call completed but that has not (yet)
 * been durably persisted. Replaces any existing entry for the account.
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
	pending.set(accountId, { ...rotation, recordedAt: Date.now() });
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
 * - "persisted": CAS landed; entry cleared.
 * - "superseded": CAS matched 0 rows — the DB moved past the consumed token
 *   (manual re-auth or a newer rotation persisted); entry cleared, the DB is
 *   the source of truth now.
 * - "failed": the write threw; entry kept for the next flush attempt.
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
			pending.delete(accountId);
			return "persisted";
		}
		pending.delete(accountId);
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
