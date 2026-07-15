import { describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { refreshAccessTokenSafe } from "../token-manager";

function makeAccount(id: string, name = "test-account"): Account {
	return {
		id,
		name,
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
	};
}

function makeContext(refreshError: Error) {
	const queuedJobs: Array<() => Promise<void>> = [];
	const setRequiresReauth = mock(async () => {});
	return {
		ctx: {
			provider: {
				name: "fake-refresh-provider",
				refreshToken: mock(async () => {
					throw refreshError;
				}),
			},
			dbOps: {
				getAccount: mock(async () => null),
				setRequiresReauth,
			},
			runtime: { clientId: "test-client" },
			refreshInFlight: new Map(),
			asyncWriter: {
				enqueue: mock((job: () => Promise<void>) => queuedJobs.push(job)),
			},
		},
		queuedJobs,
		setRequiresReauth,
	};
}

describe("refreshAccessTokenSafe requires_reauth detection", () => {
	it("enqueues the flag for a replayed invalid_grant refresh response and propagates the error", async () => {
		const { ctx, queuedJobs, setRequiresReauth } = makeContext(
			new Error(
				'Failed to refresh token for account replay: {"error":"invalid_grant","error_description":"Refresh token invalid or expired"}',
			),
		);

		await expect(
			refreshAccessTokenSafe(makeAccount("invalid-grant"), ctx as never),
		).rejects.toThrow("Failed to refresh access token");

		expect(queuedJobs).toHaveLength(1);
		await queuedJobs[0]();
		expect(setRequiresReauth).toHaveBeenCalledWith("invalid-grant", true);
	});

	it("does not flag network or upstream failures", async () => {
		const { ctx, queuedJobs, setRequiresReauth } = makeContext(
			new Error(
				"Failed to refresh token for account network: upstream 503 timeout",
			),
		);

		await expect(
			refreshAccessTokenSafe(makeAccount("network-error"), ctx as never),
		).rejects.toThrow("Failed to refresh access token");

		expect(queuedJobs).toHaveLength(0);
		expect(setRequiresReauth).not.toHaveBeenCalled();
	});

	it("ignores invalid_grant in the account name when the provider error suffix is harmless", async () => {
		const { ctx, queuedJobs, setRequiresReauth } = makeContext(
			new Error(
				"Failed to refresh token for account test_invalid_grant: temporary upstream failure",
			),
		);

		await expect(
			refreshAccessTokenSafe(
				makeAccount("name-false-positive", "test_invalid_grant"),
				ctx as never,
			),
		).rejects.toThrow("Failed to refresh access token");

		expect(queuedJobs).toHaveLength(0);
		expect(setRequiresReauth).not.toHaveBeenCalled();
	});
});
