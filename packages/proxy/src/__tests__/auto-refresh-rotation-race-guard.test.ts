/**
 * Tests for the rotation-race guard in AutoRefreshScheduler.flagIfDefinitiveAuthFailure.
 *
 * The proactive refresh paths (qwen/xai, codex) call provider.refreshToken()
 * directly, bypassing the token-manager funnel fixed in Tasks 1-2. If another
 * consumer rotated the refresh token between the scheduler's loop-start
 * snapshot and this refresh attempt, a definitive-looking rejection
 * (invalid_grant, etc.) condemns a superseded token, not the account itself.
 * The guard uses a single compare-and-set write — condemning the account only
 * if it still holds the exact refresh token this attempt used — instead of a
 * separate read-then-write, closing the race window between them. That CAS
 * write goes through proxyContext.dbOps.flagRequiresReauthIfTokenMatches (a
 * retry-wrapped method shared with the token-manager funnel), not raw SQL.
 *
 * A pending rotation registered by the proactive persist paths (this file's
 * sibling, auto-refresh-proactive-requires-reauth) takes priority over the
 * CAS write entirely: it means a rotation already succeeded at the provider
 * moments ago and is merely waiting to be persisted, so the "failure" being
 * handled here is just a replay of the now-consumed token.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import {
	clearAllPendingRotationsForTests,
	recordPendingRotation,
} from "../handlers/pending-rotation-registry";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock DB adapter with a spy on `run` (used for non-CAS writes). */
function makeDb() {
	const runCalls: Array<[string, unknown[]]> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async () => []),
		runCalls,
	};
}

/**
 * Build a minimal mock ProxyContext with a mockable
 * dbOps.flagRequiresReauthIfTokenMatches.
 *
 * `flagOutcome` controls what the CAS flag write reports back:
 * - `true` — the row still held the expected refresh token; flagged.
 * - `false` — the row's refresh token had already changed; not flagged.
 * - an `Error` — the write rejects (DB unavailable).
 */
function makeProxyContext(flagOutcome: boolean | Error = true) {
	const flagCalls: Array<[string, string]> = [];
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
		dbOps: {
			flagRequiresReauthIfTokenMatches: mock(
				async (accountId: string, expectedRefreshToken: string) => {
					flagCalls.push([accountId, expectedRefreshToken]);
					if (flagOutcome instanceof Error) throw flagOutcome;
					return flagOutcome;
				},
			),
		},
		flagCalls,
	};
}

/** Instantiate the scheduler without starting the interval. */
async function makeScheduler(
	db: ReturnType<typeof makeDb>,
	proxyContext: ReturnType<typeof makeProxyContext>,
) {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		proxyContext as never,
	) as AutoRefreshScheduler & {
		flagIfDefinitiveAuthFailure(
			error: unknown,
			row: {
				id: string;
				name: string;
				provider: string;
				refresh_token: string;
			},
		): Promise<void>;
	};
}

const row = {
	id: "acc-1",
	name: "test-account",
	provider: "qwen",
	refresh_token: "RT1-consumed",
};
const invalidGrant = new Error(
	"Failed to refresh token for account test-account: invalid_grant: token expired",
);

/** Collect authFailureEvents emitted while running `fn`. */
async function collectEvents(
	fn: () => Promise<void>,
): Promise<AuthFailureEvt[]> {
	const events: AuthFailureEvt[] = [];
	const listener = (e: AuthFailureEvt) => events.push(e);
	authFailureEvents.on("event", listener);
	try {
		await fn();
	} finally {
		authFailureEvents.off("event", listener);
	}
	return events;
}

beforeEach(() => {
	clearAllPendingRotationsForTests();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AutoRefreshScheduler — rotation-race guard before requires_reauth", () => {
	it("skips flagging when the CAS write matches no row (refresh token rotated underneath)", async () => {
		const db = makeDb();
		const proxyContext = makeProxyContext(false);
		const scheduler = await makeScheduler(db, proxyContext);

		const events = await collectEvents(() =>
			scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row),
		);

		expect(proxyContext.flagCalls).toEqual([["acc-1", "RT1-consumed"]]);
		expect(
			db.runCalls.find(([sql]) => sql.includes("requires_reauth")),
		).toBeUndefined();
		expect(events).toHaveLength(0);
	});

	it("flags when the CAS write matches the row (refresh token still current)", async () => {
		const db = makeDb();
		const proxyContext = makeProxyContext(true);
		const scheduler = await makeScheduler(db, proxyContext);

		const events = await collectEvents(() =>
			scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row),
		);

		expect(proxyContext.flagCalls).toEqual([["acc-1", "RT1-consumed"]]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			accountId: "acc-1",
			accountName: "test-account",
			provider: "qwen",
			reason: "invalid_grant",
		});
	});

	it("does NOT flag when the DB cannot be written/read", async () => {
		const db = makeDb();
		const proxyContext = makeProxyContext(new Error("db unavailable"));
		const scheduler = await makeScheduler(db, proxyContext);

		const events = await collectEvents(() =>
			scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row),
		);

		expect(events).toHaveLength(0);
		expect(
			db.runCalls.find(([sql]) => sql.includes("requires_reauth")),
		).toBeUndefined();
	});

	it("does nothing for non-definitive errors", async () => {
		const db = makeDb();
		const proxyContext = makeProxyContext(true);
		const scheduler = await makeScheduler(db, proxyContext);

		await scheduler.flagIfDefinitiveAuthFailure(
			new Error("upstream 503 timeout"),
			row,
		);

		expect(db.runCalls).toHaveLength(0);
		expect(proxyContext.flagCalls).toHaveLength(0);
	});

	it("skips flagging when a pending rotation exists for the row", async () => {
		const db = makeDb();
		const proxyContext = makeProxyContext(true);
		recordPendingRotation(row.id, {
			accessToken: "at-new",
			expiresAt: Date.now() + 60_000,
			refreshToken: "rt-new",
			attemptedRefreshToken: row.refresh_token,
		});
		const scheduler = await makeScheduler(db, proxyContext);

		const events = await collectEvents(() =>
			scheduler.flagIfDefinitiveAuthFailure(invalidGrant, row),
		);

		expect(proxyContext.flagCalls).toHaveLength(0);
		expect(events).toHaveLength(0);
	});
});
