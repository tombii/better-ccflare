import { describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import {
	extractAuthFailureReason,
	isDefinitiveAuthFailure,
	refreshAccessTokenSafe,
} from "../token-manager";

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

describe("extractAuthFailureReason / isDefinitiveAuthFailure", () => {
	it("classifies a realistic invalid_grant message (code preserved mid-message)", () => {
		const message =
			"Failed to refresh token for account my-acct: invalid_grant: Refresh token is invalid or has been revoked.";
		expect(isDefinitiveAuthFailure(message, "my-acct")).toBe(true);
		expect(extractAuthFailureReason(message, "my-acct")).toBe("invalid_grant");
	});

	it("matches a bare code with no description", () => {
		const message =
			"Failed to refresh token for account my-acct: invalid_grant";
		expect(extractAuthFailureReason(message, "my-acct")).toBe("invalid_grant");
	});

	it("classifies the Codex refresh_token_reused marker inside a multi-colon message", () => {
		const message =
			"Failed to refresh Codex token for account my-acct: refresh_token_reused - the refresh token was already used; re-authenticate with: bun run cli --reauthenticate my-acct";
		expect(extractAuthFailureReason(message, "my-acct")).toBe(
			"refresh_token_reused",
		);
	});

	it("does not fire on transient network/5xx messages", () => {
		expect(
			isDefinitiveAuthFailure(
				"Failed to refresh token for account my-acct: upstream 503 timeout",
				"my-acct",
			),
		).toBe(false);
	});

	it("cannot be tripped by an account NAME containing invalid_grant", () => {
		const message =
			"Failed to refresh token for account test_invalid_grant: temporary upstream failure";
		expect(isDefinitiveAuthFailure(message, "test_invalid_grant")).toBe(false);
		expect(extractAuthFailureReason(message, "test_invalid_grant")).toBeNull();
	});

	it("still fires on a real code even when the account name is a code substring", () => {
		// Account literally named "grant" must not suppress a genuine invalid_grant —
		// framing is anchored on "account grant", never on the code text.
		const message =
			"Failed to refresh token for account grant: invalid_grant: Refresh token is invalid.";
		expect(extractAuthFailureReason(message, "grant")).toBe("invalid_grant");
	});
});

describe("refreshAccessTokenSafe requires_reauth detection", () => {
	it("enqueues the flag for a realistic invalid_grant refresh error and propagates it", async () => {
		const { ctx, queuedJobs, setRequiresReauth } = makeContext(
			new Error(
				"Failed to refresh token for account test-account: invalid_grant: Refresh token is invalid or has been revoked.",
			),
		);
		const emitted: AuthFailureEvt[] = [];
		authFailureEvents.once("event", (event) => emitted.push(event));

		await expect(
			refreshAccessTokenSafe(makeAccount("invalid-grant"), ctx as never),
		).rejects.toThrow("Failed to refresh access token");

		expect(queuedJobs).toHaveLength(1);
		await queuedJobs[0]();
		expect(setRequiresReauth).toHaveBeenCalledWith("invalid-grant", true);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			accountId: "invalid-grant",
			accountName: "test-account",
			provider: "fake-refresh-provider",
		});
		// The emitted reason is the CLASSIFIED code, not the raw suffix.
		expect(emitted[0]?.reason).toBe("invalid_grant");
	});

	it("does not flag network or upstream failures", async () => {
		const { ctx, queuedJobs, setRequiresReauth } = makeContext(
			new Error(
				"Failed to refresh token for account test-account: upstream 503 timeout",
			),
		);

		await expect(
			refreshAccessTokenSafe(makeAccount("network-error"), ctx as never),
		).rejects.toThrow("Failed to refresh access token");

		expect(queuedJobs).toHaveLength(0);
		expect(setRequiresReauth).not.toHaveBeenCalled();
	});

	it("ignores invalid_grant in the account name when the provider error is harmless", async () => {
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
