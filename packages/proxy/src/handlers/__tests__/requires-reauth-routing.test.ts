import { describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { selectAccountsForRequest } from "../account-selector";
import { createPoolExhaustedResponse } from "../proxy-operations";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-1",
		name: "Account 1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3_600_000,
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

describe("requires_reauth routing", () => {
	it("never force-routes a flagged rate-limited account through the scheduler bypass", async () => {
		const flagged = makeAccount({
			id: "flagged",
			requires_reauth: true,
			rate_limited_until: Date.now() + 3_600_000,
		});
		const healthy = makeAccount({ id: "healthy", name: "Healthy" });
		const ctx = {
			strategy: { select: mock(() => [healthy]) },
			dbOps: {
				getAllAccounts: mock(async () => [flagged, healthy]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		};
		const meta = {
			id: "request-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			headers: new Headers({
				"x-better-ccflare-account-id": "flagged",
				"x-better-ccflare-bypass-session": "true",
			}),
		} as RequestMeta;

		const selected = await selectAccountsForRequest(meta, ctx as never);

		expect(selected.map((candidate) => candidate.id)).toEqual(["healthy"]);
	});

	it("reports requires_reauth as the pool-exhaustion reason", async () => {
		const response = createPoolExhaustedResponse([
			makeAccount({ requires_reauth: true }),
		]);
		const body = (await response.json()) as {
			error: { accounts: Array<{ reason: string }> };
		};

		expect(body.error.accounts[0]?.reason).toBe("requires_reauth");
	});
});
