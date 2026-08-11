import { describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { refreshAccessTokenSafe } from "../token-manager";

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
