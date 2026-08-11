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

	it("still flags requires_reauth when the rejected RT is the account's current one", async () => {
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
		const { ctx, setRequiresReauth, queuedJobs } = makeContext({
			refreshError: invalidGrant,
		});
		ctx.dbOps.getAccount = mock(async () => sameDb);

		await expect(
			refreshAccessTokenSafe(account as never, ctx as never),
		).rejects.toThrow();

		for (const job of queuedJobs) await job();
		expect(setRequiresReauth).toHaveBeenCalledTimes(1);
		expect(setRequiresReauth).toHaveBeenCalledWith("race-catch-flag-1", true);
	});
});
