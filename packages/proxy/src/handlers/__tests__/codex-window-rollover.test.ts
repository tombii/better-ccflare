import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { updateAccountMetadata } from "../response-processor";

const PREVIOUS_FIVE_HOUR_RESET = "2026-07-21T00:00:00.000Z";
const NEXT_FIVE_HOUR_RESET = "2026-07-21T05:00:00.000Z";
const PREVIOUS_WEEKLY_RESET = "2026-07-20T00:00:00.000Z";
const NEXT_WEEKLY_RESET = "2026-07-27T00:00:00.000Z";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-codex-1",
		name: "codex-test-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1_784_505_600_000,
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

type UsageWindow = { utilization: number; resets_at: string | null };

type CachedCodexUsage = {
	five_hour?: UsageWindow;
	seven_day?: UsageWindow;
};

function seedUsage(accountId: string, usage: CachedCodexUsage): void {
	usageCache.set(accountId, usage);
}

function makeCodexResponse(options: {
	fiveHourReset?: string;
	weeklyReset: string;
}): Response {
	const headers = new Headers({
		"x-codex-primary-used-percent": "35",
		"x-codex-primary-window-minutes": options.fiveHourReset ? "300" : "10080",
		"x-codex-primary-reset-at": String(
			Date.parse(options.fiveHourReset ?? options.weeklyReset) / 1000,
		),
	});
	if (options.fiveHourReset) {
		headers.set("x-codex-secondary-used-percent", "15");
		headers.set("x-codex-secondary-window-minutes", "10080");
		headers.set(
			"x-codex-secondary-reset-at",
			String(Date.parse(options.weeklyReset) / 1000),
		);
	}
	return new Response(null, { status: 200, headers });
}

function makeCtx(fiveHourWindowEnabled?: boolean) {
	const calls = {
		resetAccountSession: [] as Array<{ accountId: string; now: number }>,
		runs: [] as Array<{ sql: string; params: unknown[] | undefined }>,
	};
	const pendingJobs: Promise<unknown>[] = [];
	const ctx = {
		provider: {
			name: "codex",
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
		},
		config: {
			getCodexFiveHourWindowEnabled: () => fiveHourWindowEnabled ?? false,
		},
		dbOps: {
			updateAccountUsage: async () => {},
			updateAccountRateLimitMeta: async () => {},
			resetAccountSession: async (accountId: string, now: number) => {
				calls.resetAccountSession.push({ accountId, now });
			},
			getAdapter: () => ({
				run: async (sql: string, params?: unknown[]) => {
					calls.runs.push({ sql, params });
				},
			}),
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				const result = Promise.resolve(job());
				pendingJobs.push(result);
			},
		},
	} as unknown as ProxyContext;

	return {
		ctx,
		calls,
		flush: async () => {
			await Promise.all(pendingJobs);
			await Promise.resolve();
		},
	};
}

afterEach(() => {
	usageCache.clear();
});

describe("Codex usage-window session rollover", () => {
	it("does not reset affinity when a future sliding deadline advances", async () => {
		const account = makeAccount();
		const futureReset = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const laterFutureReset = new Date(
			Date.now() + 2 * 60 * 60 * 1000,
		).toISOString();
		seedUsage(account.id, {
			five_hour: { utilization: 20, resets_at: futureReset },
			seven_day: { utilization: 15, resets_at: NEXT_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx();

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: laterFutureReset,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(0);
	});

	it("does not reset affinity after elapsed deadline when utilization keeps rising", async () => {
		const account = makeAccount();
		const elapsedReset = new Date(Date.now() - 60_000).toISOString();
		const nextReset = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
		seedUsage(account.id, {
			five_hour: { utilization: 20, resets_at: elapsedReset },
			seven_day: { utilization: 15, resets_at: NEXT_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx();

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: nextReset,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(0);
	});

	it("resets affinity after elapsed deadline and utilization wraps", async () => {
		const account = makeAccount();
		const elapsedReset = new Date(Date.now() - 60_000).toISOString();
		const nextReset = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
		seedUsage(account.id, {
			five_hour: { utilization: 90, resets_at: elapsedReset },
			seven_day: { utilization: 15, resets_at: NEXT_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx();

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: nextReset,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(1);
	});

	it("resets the session from the weekly window when the default flag is false and no 5-hour window is reported", async () => {
		const account = makeAccount();
		seedUsage(account.id, {
			seven_day: { utilization: 90, resets_at: PREVIOUS_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx();
		expect(ctx.config.getCodexFiveHourWindowEnabled()).toBe(false);

		updateAccountMetadata(
			account,
			makeCodexResponse({ weeklyReset: NEXT_WEEKLY_RESET }),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(1);
		expect(calls.resetAccountSession[0]?.accountId).toBe(account.id);
	});

	it("resets the session from the reported 5-hour window when the default flag is false", async () => {
		const account = makeAccount();
		seedUsage(account.id, {
			five_hour: { utilization: 90, resets_at: PREVIOUS_FIVE_HOUR_RESET },
			seven_day: { utilization: 15, resets_at: NEXT_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx();

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: NEXT_FIVE_HOUR_RESET,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(1);
	});

	it("does not reset the session from the weekly window when the flag is true and no 5-hour window is reported", async () => {
		const account = makeAccount();
		seedUsage(account.id, {
			seven_day: { utilization: 20, resets_at: PREVIOUS_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx(true);

		updateAccountMetadata(
			account,
			makeCodexResponse({ weeklyReset: NEXT_WEEKLY_RESET }),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(0);
	});

	it("does not reset the session without cached usage when the flag is false", async () => {
		const account = makeAccount();
		const { ctx, calls, flush } = makeCtx(false);

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: NEXT_FIVE_HOUR_RESET,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(0);
	});

	it("does not reset the session without cached usage when the flag is true", async () => {
		const account = makeAccount();
		const { ctx, calls, flush } = makeCtx(true);

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: NEXT_FIVE_HOUR_RESET,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(0);
	});

	it("does not reset the session when the tracked window moves backward", async () => {
		const account = makeAccount();
		seedUsage(account.id, {
			five_hour: { utilization: 20, resets_at: NEXT_FIVE_HOUR_RESET },
			seven_day: { utilization: 15, resets_at: NEXT_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx();

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: PREVIOUS_FIVE_HOUR_RESET,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(0);
	});

	it("does not reset the session when the tracked window is unchanged", async () => {
		const account = makeAccount();
		seedUsage(account.id, {
			five_hour: { utilization: 20, resets_at: NEXT_FIVE_HOUR_RESET },
			seven_day: { utilization: 15, resets_at: NEXT_WEEKLY_RESET },
		});
		const { ctx, calls, flush } = makeCtx();

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: NEXT_FIVE_HOUR_RESET,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.resetAccountSession).toHaveLength(0);
	});

	it("writes rate_limit_reset as the earliest reported reset regardless of the flag", async () => {
		const account = makeAccount();
		const { ctx, calls, flush } = makeCtx(true);

		updateAccountMetadata(
			account,
			makeCodexResponse({
				fiveHourReset: NEXT_FIVE_HOUR_RESET,
				weeklyReset: NEXT_WEEKLY_RESET,
			}),
			ctx,
		);
		await flush();

		expect(calls.runs).toContainEqual({
			sql: "UPDATE accounts SET rate_limit_reset = ? WHERE id = ?",
			params: [Date.parse(NEXT_FIVE_HOUR_RESET), account.id],
		});
	});
});
