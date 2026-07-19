import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { AnthropicProvider } from "../provider";

function oauthAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "anthropic-1",
		name: "anthropic-test",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "expired-access-token",
		expires_at: 1,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
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

describe("AnthropicProvider.refreshToken preserves the OAuth error code", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps the machine-readable invalid_grant code when error_description is present", async () => {
		const provider = new AnthropicProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "Refresh token is invalid or has been revoked.",
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(oauthAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown).not.toBeNull();
		// The machine code must survive in the thrown message so the token-manager's
		// requires_reauth detection can classify it — a description-only message hides it.
		expect(thrown?.message).toContain("invalid_grant");
	});

	it("still surfaces the code for a bare error payload without a description", async () => {
		const provider = new AnthropicProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(oauthAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown?.message).toContain("invalid_grant");
	});
});
