import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

describe("AutoRefreshScheduler 401 probe handling", () => {
	it("expires the access token and disables auto-refresh without setting requires_reauth", async () => {
		const runCalls: Array<[string, unknown[]]> = [];
		const db = {
			run: mock(async (sql: string, params: unknown[]) => {
				runCalls.push([sql, params]);
			}),
			query: mock(async () => []),
		};
		global.fetch = mock(
			async () => new Response("Unauthorized", { status: 401 }),
		);

		const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
		const scheduler = new AutoRefreshScheduler(
			db as never,
			{
				runtime: { port: 8080, clientId: "test-client" },
				refreshInFlight: new Map(),
			} as never,
		) as AutoRefreshScheduler & {
			sendDummyMessage(account: {
				id: string;
				name: string;
				provider: string;
				refresh_token: string;
				access_token: string;
				expires_at: number;
				rate_limit_reset: null;
				custom_endpoint: null;
				paused: number;
				auto_pause_on_overage_enabled: number;
				pause_reason: null;
			}): Promise<boolean>;
		};

		const result = await scheduler.sendDummyMessage({
			id: "account-401",
			name: "Account 401",
			provider: "anthropic",
			refresh_token: "refresh-token",
			access_token: "expired-token",
			expires_at: 1,
			rate_limit_reset: null,
			custom_endpoint: null,
			paused: 0,
			auto_pause_on_overage_enabled: 0,
			pause_reason: null,
		});

		expect(result).toBe(false);
		expect(runCalls).toHaveLength(1);
		const [sql, params] = runCalls[0];
		expect(sql).toContain("auto_refresh_enabled = 0");
		expect(sql).toContain("expires_at = 0");
		expect(sql).not.toContain("requires_reauth");
		expect(params).toEqual(["account-401"]);
	});
});
