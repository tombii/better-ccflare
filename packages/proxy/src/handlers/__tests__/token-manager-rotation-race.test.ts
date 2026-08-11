import { beforeEach, describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import {
	clearAllPendingRotationsForTests,
	getPendingRotation,
} from "../pending-rotation-registry";
import { refreshAccessTokenSafe } from "../token-manager";

beforeEach(() => {
	clearAllPendingRotationsForTests();
});

function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: "test-account",
		provider: "fake-refresh-provider",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "expired-access-token",
		expires_at: 1,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
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

function makeContext(opts: {
	dbAccount?: Account | null;
	refreshResult?: {
		accessToken: string;
		expiresAt: number;
		refreshToken?: string;
	};
	refreshError?: Error;
}) {
	const queuedJobs: Array<() => Promise<void>> = [];
	const setRequiresReauth = mock(async () => {});
	const refreshCalls: Array<{ refreshTokenAtCall: string | null }> = [];
	const refreshToken = mock(async (account: Account) => {
		refreshCalls.push({ refreshTokenAtCall: account.refresh_token });
		if (opts.refreshError) throw opts.refreshError;
		return (
			opts.refreshResult ?? {
				accessToken: "new-access-token",
				expiresAt: Date.now() + 3_600_000,
			}
		);
	});
	return {
		ctx: {
			provider: { name: "fake-refresh-provider", refreshToken },
			dbOps: {
				getAccount: mock(async () => opts.dbAccount ?? null),
				setRequiresReauth,
				updateAccountTokens: mock(async () => {}),
				updateAccountTokensIfRefreshTokenMatches: mock(async () => true),
				updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
				flagRequiresReauthIfTokenMatches: mock(async () => true),
			},
			runtime: { clientId: "test-client" },
			refreshInFlight: new Map(),
			asyncWriter: {
				enqueue: mock((job: () => Promise<void>) => queuedJobs.push(job)),
			},
		},
		queuedJobs,
		setRequiresReauth,
		refreshToken,
		refreshCalls,
	};
}

describe("refreshAccessTokenSafe — rotation-race pre-refresh guard", () => {
	it("adopts a fresher valid token from the DB and skips the provider refresh", async () => {
		const account = makeAccount("race-adopt-1", {
			refresh_token: "RT1-stale",
			access_token: "stale-access",
			expires_at: 1,
		});
		const dbAccount = makeAccount("race-adopt-1", {
			refresh_token: "RT2-current",
			access_token: "fresh-access",
			expires_at: Date.now() + 3_600_000,
			refresh_token_issued_at: Date.now(),
		});
		const { ctx, refreshToken } = makeContext({ dbAccount });

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("fresh-access");
		expect(refreshToken).not.toHaveBeenCalled();
		// in-memory snapshot healed
		expect(account.access_token).toBe("fresh-access");
		expect(account.refresh_token).toBe("RT2-current");
	});

	it("still refreshes when the DB row matches the snapshot (no race)", async () => {
		const account = makeAccount("race-norace-1", {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const dbAccount = makeAccount("race-norace-1", {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const { ctx, refreshToken } = makeContext({
			dbAccount,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
			},
		});

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("brand-new");
		expect(refreshToken).toHaveBeenCalledTimes(1);
	});

	it("uses the DB's rotated refresh token when a refresh is still needed", async () => {
		// DB has a newer RT but its access token is also expired → refresh must
		// run, but with RT2, not the snapshot's consumed RT1.
		const account = makeAccount("race-rt-sync-1", {
			refresh_token: "RT1-consumed",
			access_token: "stale-access",
			expires_at: 1,
		});
		const dbAccount = makeAccount("race-rt-sync-1", {
			refresh_token: "RT2-current",
			access_token: "also-expired",
			expires_at: 2,
			refresh_token_issued_at: Date.now(),
		});
		const { ctx, refreshCalls } = makeContext({
			dbAccount,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
			},
		});

		await refreshAccessTokenSafe(account as never, ctx as never);

		expect(refreshCalls[0]?.refreshTokenAtCall).toBe("RT2-current");
	});

	it("proceeds to refresh when the account is missing from the DB", async () => {
		const account = makeAccount("race-nodb-1", {
			refresh_token: "RT1",
			access_token: "stale",
			expires_at: 1,
		});
		const { ctx, refreshToken } = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
			},
		});

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("brand-new");
		expect(refreshToken).toHaveBeenCalledTimes(1);
	});

	it("does not adopt an older refresh token from a delayed DB state (finding 6, test F)", async () => {
		// account (memory) already rotated to RT2 at t=2000; the DB row is a
		// delayed snapshot still showing RT1 issued at t=1000. A DB read that
		// merely differs from memory must never be treated as "fresher" —
		// only a strictly newer issued_at may override the in-memory RT.
		const account = makeAccount("no-adopt-older-rt-1", {
			refresh_token: "RT2",
			refresh_token_issued_at: 2000,
			access_token: "expired-mem",
			expires_at: 1,
		});
		const dbAccount = makeAccount("no-adopt-older-rt-1", {
			refresh_token: "RT1",
			refresh_token_issued_at: 1000,
			access_token: "also-expired-db",
			expires_at: 2,
		});
		const { ctx, refreshCalls } = makeContext({
			dbAccount,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
			},
		});

		await refreshAccessTokenSafe(account as never, ctx as never);

		expect(refreshCalls[0]?.refreshTokenAtCall).toBe("RT2");
		expect(account.refresh_token).toBe("RT2");
	});

	it("adopts when DB expiry is strictly newer even if access token string equal (finding 6, test G)", async () => {
		const sharedAccessToken = "same-access-token-string";
		const account = makeAccount("adopt-newer-expiry-1", {
			refresh_token: "RT1",
			access_token: sharedAccessToken,
			expires_at: 1,
		});
		const dbAccount = makeAccount("adopt-newer-expiry-1", {
			refresh_token: "RT1",
			access_token: sharedAccessToken,
			expires_at: Date.now() + 2 * 60 * 60 * 1000,
			refresh_token_issued_at: Date.now(),
		});
		const { ctx, refreshToken } = makeContext({ dbAccount });

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe(sharedAccessToken);
		expect(refreshToken).not.toHaveBeenCalled();
		expect(account.expires_at).toBe(dbAccount.expires_at);
	});
});

describe("refreshAccessTokenSafe — benign race on invalid_grant", () => {
	const invalidGrant = new Error(
		"Status 400, Error: invalid_grant: Refresh token not found or invalid",
	);

	it("recovers with DB tokens instead of flagging when the RT was rotated meanwhile", async () => {
		const account = makeAccount("race-catch-recover-1", {
			refresh_token: "RT1-consumed",
			access_token: "stale",
			expires_at: 1,
		});
		const dbAccount = makeAccount("race-catch-recover-1", {
			refresh_token: "RT2-current",
			access_token: "fresh-access",
			expires_at: Date.now() + 3_600_000,
		});
		// getAccount: first call (pre-refresh guard) must NOT short-circuit, so
		// return the stale state first, then the rotated state for the catch.
		const staleDb = makeAccount("race-catch-recover-1", {
			refresh_token: "RT1-consumed",
			access_token: "stale",
			expires_at: 1,
		});
		const { ctx, setRequiresReauth, queuedJobs } = makeContext({
			refreshError: invalidGrant,
		});
		let call = 0;
		ctx.dbOps.getAccount = mock(async () =>
			call++ === 0 ? staleDb : dbAccount,
		);

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			const token = await refreshAccessTokenSafe(
				account as never,
				ctx as never,
			);
			expect(token).toBe("fresh-access");
		} finally {
			authFailureEvents.off("event", listener);
		}

		for (const job of queuedJobs) await job();
		expect(setRequiresReauth).not.toHaveBeenCalled();
		expect(events).toHaveLength(0);
		expect(account.refresh_token).toBe("RT2-current");
	});

	it("does not flag when the RT was rotated but no valid access token exists yet (throws, retries later)", async () => {
		const account = makeAccount("race-catch-noflag-1", {
			refresh_token: "RT1-consumed",
			access_token: "stale",
			expires_at: 1,
		});
		const staleDb = makeAccount("race-catch-noflag-1", {
			refresh_token: "RT1-consumed",
			access_token: "stale",
			expires_at: 1,
		});
		const rotatedDb = makeAccount("race-catch-noflag-1", {
			refresh_token: "RT2-current",
			access_token: "also-expired",
			expires_at: 2,
		});
		const { ctx, setRequiresReauth, queuedJobs } = makeContext({
			refreshError: invalidGrant,
		});
		let call = 0;
		ctx.dbOps.getAccount = mock(async () =>
			call++ === 0 ? staleDb : rotatedDb,
		);

		await expect(
			refreshAccessTokenSafe(account as never, ctx as never),
		).rejects.toThrow();

		for (const job of queuedJobs) await job();
		expect(setRequiresReauth).not.toHaveBeenCalled();
		expect(account.refresh_token).toBe("RT2-current");
	});

	it("still flags requires_reauth via the CAS write when the rejected RT is the account's current one", async () => {
		const account = makeAccount("race-catch-flag-1", {
			refresh_token: "RT1-dead",
			access_token: "stale",
			expires_at: 1,
		});
		const sameDb = makeAccount("race-catch-flag-1", {
			refresh_token: "RT1-dead",
			access_token: "stale",
			expires_at: 1,
		});
		const { ctx } = makeContext({
			refreshError: invalidGrant,
		});
		ctx.dbOps.getAccount = mock(async () => sameDb);

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			await expect(
				refreshAccessTokenSafe(account as never, ctx as never),
			).rejects.toThrow();
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(ctx.dbOps.flagRequiresReauthIfTokenMatches).toHaveBeenCalledWith(
			"race-catch-flag-1",
			"RT1-dead",
		);
		expect(events).toHaveLength(1);
	});

	it("emits the auth-failure event only when the CAS flag write actually succeeds (finding 2, test B)", async () => {
		const account = makeAccount("flag-cas-fail-1", {
			refresh_token: "RT1-dead",
			access_token: "stale",
			expires_at: 1,
		});
		const sameDb = makeAccount("flag-cas-fail-1", {
			refresh_token: "RT1-dead",
			access_token: "stale",
			expires_at: 1,
		});
		const { ctx } = makeContext({ refreshError: invalidGrant });
		ctx.dbOps.getAccount = mock(async () => sameDb);
		// Someone rotated the token between our verification read and the flag
		// write — the CAS write is a no-op and must not be treated as success.
		ctx.dbOps.flagRequiresReauthIfTokenMatches = mock(async () => false);

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			await expect(
				refreshAccessTokenSafe(account as never, ctx as never),
			).rejects.toThrow();
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(ctx.dbOps.flagRequiresReauthIfTokenMatches).toHaveBeenCalledWith(
			"flag-cas-fail-1",
			"RT1-dead",
		);
		expect(events).toHaveLength(0);
	});

	it("does not flag when the recovery DB read fails (finding 3, test C)", async () => {
		const account = makeAccount("no-flag-db-read-fail-1", {
			refresh_token: "RT1-dead",
			access_token: "stale",
			expires_at: 1,
		});
		const { ctx } = makeContext({ refreshError: invalidGrant });
		// Every getAccount call fails: the pre-refresh guard swallows its own
		// failure internally and proceeds; the post-failure recovery read is
		// the one that matters here and must leave requires_reauth unverified.
		ctx.dbOps.getAccount = mock(async () => {
			throw new Error("db unavailable");
		});

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			await expect(
				refreshAccessTokenSafe(account as never, ctx as never),
			).rejects.toThrow();
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(ctx.dbOps.flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
		expect(events).toHaveLength(0);
	});

	it("does not flag and rejects with TokenRefreshError when the CAS flag write itself rejects", async () => {
		const account = makeAccount("flag-cas-rejects-1", {
			refresh_token: "RT1-dead",
			access_token: "stale",
			expires_at: 1,
		});
		const sameDb = makeAccount("flag-cas-rejects-1", {
			refresh_token: "RT1-dead",
			access_token: "stale",
			expires_at: 1,
		});
		const { ctx } = makeContext({ refreshError: invalidGrant });
		ctx.dbOps.getAccount = mock(async () => sameDb);
		// The CAS write itself throws (e.g. a transient DB error), not merely
		// resolving false — the surrounding try/catch must swallow it and leave
		// requires_reauth unset rather than letting it propagate unexpectedly.
		ctx.dbOps.flagRequiresReauthIfTokenMatches = mock(async () => {
			throw new Error("db write failed");
		});

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			await expect(
				refreshAccessTokenSafe(account as never, ctx as never),
			).rejects.toThrow("Failed to refresh access token");
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(ctx.dbOps.flagRequiresReauthIfTokenMatches).toHaveBeenCalledWith(
			"flag-cas-rejects-1",
			"RT1-dead",
		);
		expect(events).toHaveLength(0);
	});
});

describe("refreshAccessTokenSafe — persist-in-promise and identity-safe cleanup", () => {
	it("persists rotated tokens via the awaited CAS write before the refresh promise resolves (finding 1, test A)", async () => {
		const account = makeAccount("persist-order-1", {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const { ctx, queuedJobs } = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
				refreshToken: "RT2",
			},
		});
		let persisted = false;
		ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			persisted = true;
			return true;
		});

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("brand-new");
		// The CAS write's tick-delayed resolution must have already happened by
		// the time refreshAccessTokenSafe itself resolves — proving the write
		// is awaited INSIDE the shared promise, not fired-and-forgotten.
		expect(persisted).toBe(true);
		expect(
			ctx.dbOps.updateAccountTokensIfRefreshTokenMatches,
		).toHaveBeenCalledWith(
			"persist-order-1",
			"RT1",
			"brand-new",
			expect.any(Number),
			"RT2",
		);
		// The lossy asyncWriter queue must never be used for the token write.
		expect(queuedJobs).toHaveLength(0);
	});

	it("calls the CAS write with undefined as the 5th arg when the provider returns no rotated refresh token", async () => {
		const account = makeAccount("undefined-rt-arg-1", {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const { ctx } = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
				// no refreshToken key: the provider did not rotate this time.
			},
		});

		await refreshAccessTokenSafe(account as never, ctx as never);

		expect(
			ctx.dbOps.updateAccountTokensIfRefreshTokenMatches,
		).toHaveBeenCalledWith(
			"undefined-rt-arg-1",
			"RT1",
			"brand-new",
			expect.any(Number),
			undefined,
		);
	});

	it("finally does not delete a newer in-flight entry installed while it was still settling (finding 4, test D)", async () => {
		const account = makeAccount("finally-identity-1", {
			refresh_token: "RT1",
			access_token: "stale",
			expires_at: 1,
		});
		const { ctx } = makeContext({ dbAccount: null });
		ctx.provider.refreshToken = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
			};
		});

		const pending = refreshAccessTokenSafe(account as never, ctx as never);

		// Let the synchronous setup (adoption guard's await + refreshInFlight
		// install) run to completion before mutating the map — both are
		// microtask-only, so they finish before this real timer fires.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const sentinel = Promise.resolve("sentinel-token");
		ctx.refreshInFlight.delete(account.id);
		ctx.refreshInFlight.set(account.id, sentinel);

		await pending;

		expect(ctx.refreshInFlight.get(account.id)).toBe(sentinel);
	});
});

describe("refreshAccessTokenSafe — join in-flight before backoff", () => {
	it("lets a concurrent caller join an in-flight refresh even while the account is in backoff (finding 5, test E)", async () => {
		const account = makeAccount("join-inflight-backoff-1", {
			refresh_token: "RT1",
			access_token: "stale",
			expires_at: 1,
		});
		const networkError = new Error("upstream 503 timeout");
		const { ctx, refreshToken } = makeContext({
			dbAccount: null,
			refreshError: networkError,
		});

		// Seed a recent (transient, non-auth) failure so the account is now in
		// its backoff window.
		await expect(
			refreshAccessTokenSafe(account as never, ctx as never),
		).rejects.toThrow();
		expect(ctx.refreshInFlight.has(account.id)).toBe(false);
		expect(refreshToken).toHaveBeenCalledTimes(1);

		// Simulate a refresh already in flight via another path that shares
		// this same ctx.refreshInFlight map — e.g. the auto-refresh scheduler,
		// which registers its own promise directly into the map
		// (auto-refresh-scheduler.ts) so concurrent request-triggered
		// refreshes can join it.
		const joinedRefresh = mock(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return {
				accessToken: "refresh-1-token",
				expiresAt: Date.now() + 3_600_000,
			};
		});
		ctx.provider.refreshToken = joinedRefresh;
		const inFlightPromise = joinedRefresh().then(
			(result: { accessToken: string }) => result.accessToken,
		);
		ctx.refreshInFlight.set(account.id, inFlightPromise);

		// Still well within the backoff window — a fresh caller with no
		// in-flight entry would be blocked here; this caller must instead join
		// the in-flight promise rather than throw ServiceUnavailableError.
		const joined = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(joined).toBe("refresh-1-token");
		// The original seeding mock was never called again by the joiner...
		expect(refreshToken).toHaveBeenCalledTimes(1);
		// ...and the joiner did not start a second refresh of its own either.
		expect(joinedRefresh).toHaveBeenCalledTimes(1);
	});
});

describe("refreshAccessTokenSafe — accounts with no refresh token to CAS against", () => {
	// Account.refresh_token is typed as `string` (not nullable) — the "no
	// refresh token" shape in this codebase is an empty string, not null. This
	// still exercises the exact `!attemptedRefreshToken` falsy branch.

	it("P5: uses the null-safe CAS write on success instead of the plain updateAccountTokens (round-3 item 4)", async () => {
		const account = makeAccount("no-rt-success-1", {
			refresh_token: "",
			access_token: "stale-access",
			expires_at: 1,
		});
		const { ctx } = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
			},
		});

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("brand-new");
		expect(
			ctx.dbOps.updateAccountTokensIfRefreshTokenAbsent,
		).toHaveBeenCalledWith(
			"no-rt-success-1",
			"brand-new",
			expect.any(Number),
			undefined,
		);
		expect(ctx.dbOps.updateAccountTokens).not.toHaveBeenCalled();
		expect(
			ctx.dbOps.updateAccountTokensIfRefreshTokenMatches,
		).not.toHaveBeenCalled();
	});

	it("P5b: warns and skips without throwing when the null-safe CAS write is superseded", async () => {
		const account = makeAccount("no-rt-cas-false-1", {
			refresh_token: "",
			access_token: "stale-access",
			expires_at: 1,
		});
		const { ctx } = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "brand-new",
				expiresAt: Date.now() + 3_600_000,
			},
		});
		ctx.dbOps.updateAccountTokensIfRefreshTokenAbsent = mock(async () => false);

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("brand-new");
	});

	it("does not flag or emit on invalid_grant failure — unverifiable without a refresh token to CAS against", async () => {
		const account = makeAccount("no-rt-failure-1", {
			refresh_token: "",
			access_token: "stale",
			expires_at: 1,
		});
		const noRtInvalidGrant = new Error(
			"Status 400, Error: invalid_grant: Refresh token not found or invalid",
		);
		const { ctx } = makeContext({ refreshError: noRtInvalidGrant });

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			await expect(
				refreshAccessTokenSafe(account as never, ctx as never),
			).rejects.toThrow("Failed to refresh access token");
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(ctx.dbOps.flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
		expect(events).toHaveLength(0);
	});
});

describe("refreshAccessTokenSafe — pending-rotation registry (round 3, item 1) and RT-regression guard (item 3)", () => {
	it("P1: records a pending rotation when the persist write rejects and serves the rotated token", async () => {
		const account = makeAccount("pending-persist-fail-1", {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const { ctx } = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "new-access",
				expiresAt: Date.now() + 3_600_000,
				refreshToken: "RT2",
			},
		});
		ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => {
			throw new Error("disk full");
		});

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("new-access");
		const pending = getPendingRotation("pending-persist-fail-1");
		expect(pending).toBeTruthy();
		expect(pending?.attemptedRefreshToken).toBe("RT1");
		expect(pending?.refreshToken).toBe("RT2");
		expect(pending?.accessToken).toBe("new-access");
	});

	it("P2: flushes the pending rotation before the next refresh and skips the replay", async () => {
		const accountId = "pending-flush-skip-replay-1";
		// Seed a pending rotation the same way P1 does: a successful provider
		// refresh whose persist write rejects.
		const seedAccount = makeAccount(accountId, {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const seed = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "rotated-access",
				expiresAt: Date.now() + 3_600_000,
				refreshToken: "RT2",
			},
		});
		seed.ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => {
			throw new Error("disk full");
		});
		await refreshAccessTokenSafe(seedAccount as never, seed.ctx as never);
		expect(getPendingRotation(accountId)).toBeTruthy();

		// A fresh caller shows up with a STALE snapshot (still RT1, still
		// expired) and its own ctx/refreshInFlight map. getAccount is rigged to
		// return the same STALE row regardless of the flush's outcome, so any
		// skip of the refresh below can only be explained by the new
		// pending-rotation short-circuit, not the pre-existing DB-adoption path.
		const staleAccount = makeAccount(accountId, {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const staleDbRow = makeAccount(accountId, {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const { ctx, refreshToken } = makeContext({ dbAccount: staleDbRow });
		// This time the CAS write underlying the flush succeeds.
		ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => true);

		const token = await refreshAccessTokenSafe(
			staleAccount as never,
			ctx as never,
		);

		expect(token).toBe("rotated-access");
		expect(refreshToken).not.toHaveBeenCalled();
		expect(getPendingRotation(accountId)).toBeUndefined();
	});

	it("P3: does not flag when a definitive failure hits an account with a pending rotation", async () => {
		const accountId = "pending-blocks-flag-1";
		// Seed a pending rotation with NO rotated refresh token and an
		// already-expired pending access token, so the flush-serve
		// short-circuit falls through to a real refresh attempt using the
		// still-unrotated RT1 — exactly what a replayed consumed token looks
		// like from the caller's perspective.
		const seedAccount = makeAccount(accountId, {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const seed = makeContext({
			dbAccount: null,
			refreshResult: {
				accessToken: "rotated-access-expired",
				expiresAt: 2,
			},
		});
		seed.ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => {
			throw new Error("disk full");
		});
		await refreshAccessTokenSafe(seedAccount as never, seed.ctx as never);
		expect(getPendingRotation(accountId)).toBeTruthy();

		const account = makeAccount(accountId, {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const staleDbRow = makeAccount(accountId, {
			refresh_token: "RT1",
			access_token: "stale-access",
			expires_at: 1,
		});
		const invalidGrant = new Error(
			"Status 400, Error: invalid_grant: Refresh token not found or invalid",
		);
		const { ctx } = makeContext({
			dbAccount: staleDbRow,
			refreshError: invalidGrant,
		});
		// The flush keeps failing.
		ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => {
			throw new Error("disk still full");
		});

		const events: AuthFailureEvt[] = [];
		const listener = (e: AuthFailureEvt) => events.push(e);
		authFailureEvents.on("event", listener);
		try {
			await expect(
				refreshAccessTokenSafe(account as never, ctx as never),
			).rejects.toThrow();
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(ctx.dbOps.flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
		expect(events).toHaveLength(0);
	});

	it("P4: does not regress the refresh token when adopting a newer access token (round-3 item 3)", async () => {
		const account = makeAccount("no-regress-rt-1", {
			refresh_token: "RT2",
			refresh_token_issued_at: 2000,
			access_token: "expired-mem",
			expires_at: 1,
		});
		const dbAccount = makeAccount("no-regress-rt-1", {
			refresh_token: "RT1",
			refresh_token_issued_at: 1000,
			access_token: "fresh-access-from-db",
			expires_at: Date.now() + 3_600_000,
		});
		const { ctx, refreshToken } = makeContext({ dbAccount });

		const token = await refreshAccessTokenSafe(account as never, ctx as never);

		expect(token).toBe("fresh-access-from-db");
		expect(refreshToken).not.toHaveBeenCalled();
		expect(account.refresh_token).toBe("RT2");
	});
});
