import { beforeEach, describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	recordCodexUsageSnapshot,
	resetCodexUsageHistoryThrottle,
} from "../../codex-usage-history";
import type { ProxyContext } from "../proxy-types";
import { updateAccountMetadata } from "../response-processor";

type SnapshotCall = {
	accountId: string;
	usage: Record<string, unknown>;
	timestamp: number;
};

/**
 * Only `recordUsageSnapshot` matters here; the rest of DatabaseOperations is
 * never reached by the helper.
 */
function makeDbOps(opts: { fail?: boolean } = {}) {
	const calls: SnapshotCall[] = [];
	const dbOps = {
		recordUsageSnapshot: async (
			accountId: string,
			usage: Record<string, unknown>,
			timestamp: number,
		) => {
			if (opts.fail) throw new Error("db down");
			calls.push({ accountId, usage, timestamp });
		},
	} as unknown as DatabaseOperations;
	return { dbOps, calls };
}

const REAL_WINDOWS = {
	five_hour: { utilization: 12, resets_at: "2026-07-05T12:00:00Z" },
	seven_day: { utilization: 63, resets_at: "2026-07-10T12:00:00Z" },
};

describe("recordCodexUsageSnapshot", () => {
	beforeEach(() => {
		resetCodexUsageHistoryThrottle();
	});

	it("writes the windows on the first call", async () => {
		const { dbOps, calls } = makeDbOps();
		const wrote = await recordCodexUsageSnapshot(
			dbOps,
			"acct-1",
			"codex-1",
			REAL_WINDOWS,
			1_000_000,
		);
		expect(wrote).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.accountId).toBe("acct-1");
		expect(calls[0]?.timestamp).toBe(1_000_000);
		expect(Object.keys(calls[0]?.usage ?? {}).sort()).toEqual([
			"five_hour",
			"seven_day",
		]);
	});

	it("skips a second call inside the 90s window and allows it after", async () => {
		const { dbOps, calls } = makeDbOps();
		const t0 = 1_000_000;
		expect(
			await recordCodexUsageSnapshot(dbOps, "a", "codex", REAL_WINDOWS, t0),
		).toBe(true);
		expect(
			await recordCodexUsageSnapshot(
				dbOps,
				"a",
				"codex",
				REAL_WINDOWS,
				t0 + 89_999,
			),
		).toBe(false);
		expect(calls).toHaveLength(1);
		expect(
			await recordCodexUsageSnapshot(
				dbOps,
				"a",
				"codex",
				REAL_WINDOWS,
				t0 + 90_000,
			),
		).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it("throttles per account, not globally", async () => {
		const { dbOps, calls } = makeDbOps();
		const t0 = 1_000_000;
		await recordCodexUsageSnapshot(dbOps, "a", "codex-a", REAL_WINDOWS, t0);
		await recordCodexUsageSnapshot(dbOps, "b", "codex-b", REAL_WINDOWS, t0 + 1);
		expect(calls.map((c) => c.accountId)).toEqual(["a", "b"]);
	});

	it("force bypasses the throttle (manual refresh)", async () => {
		const { dbOps, calls } = makeDbOps();
		const t0 = 1_000_000;
		await recordCodexUsageSnapshot(dbOps, "a", "codex", REAL_WINDOWS, t0);
		expect(
			await recordCodexUsageSnapshot(
				dbOps,
				"a",
				"codex",
				REAL_WINDOWS,
				t0 + 1,
				true,
			),
		).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it("drops synthetic windows and writes nothing when every window is synthetic", async () => {
		const { dbOps, calls } = makeDbOps();
		// parseCodexUsageHeaders fills an absent window with resets_at: null and
		// the default utilization — recording that would write a false 0%.
		const wrote = await recordCodexUsageSnapshot(
			dbOps,
			"a",
			"codex",
			{
				five_hour: { utilization: 0, resets_at: null },
				seven_day: { utilization: 0, resets_at: null },
			},
			1_000_000,
		);
		expect(wrote).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("keeps the real window when only one is synthetic", async () => {
		const { dbOps, calls } = makeDbOps();
		await recordCodexUsageSnapshot(
			dbOps,
			"a",
			"codex",
			{
				five_hour: { utilization: 0, resets_at: null },
				seven_day: { utilization: 63, resets_at: "2026-07-10T12:00:00Z" },
			},
			1_000_000,
		);
		expect(Object.keys(calls[0]?.usage ?? {})).toEqual(["seven_day"]);
	});

	it("swallows a DB failure and reports it did not write", async () => {
		const { dbOps } = makeDbOps({ fail: true });
		expect(
			await recordCodexUsageSnapshot(
				dbOps,
				"a",
				"codex",
				REAL_WINDOWS,
				1_000_000,
			),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Wiring: the proxy response path must hand the parsed windows to the helper.
// updateAccountMetadata is the function that owns the Codex usage block.
// ---------------------------------------------------------------------------

function makeCodexAccount(): Account {
	return {
		id: "codex-acct",
		name: "codex-1",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
	} as Account;
}

function makeCodexCtx() {
	const snapshots: SnapshotCall[] = [];
	const jobs: Array<() => void | Promise<void>> = [];
	const ctx = {
		provider: {
			name: "codex",
			isStreamingResponse: () => false,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		// Read by updateAccountMetadata's Codex block once #428 lands, which
		// picks the usage window a session is riding from the config. Harmless
		// without it, and it keeps this test off the failure list either way.
		config: {
			getCodexFiveHourWindowEnabled: () => false,
		},
		dbOps: {
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
			resetAccountSession: async () => {},
			recordUsageSnapshot: async (
				accountId: string,
				usage: Record<string, unknown>,
				timestamp: number,
			) => {
				snapshots.push({ accountId, usage, timestamp });
			},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				jobs.push(job);
			},
		},
	} as unknown as ProxyContext;
	return { ctx, snapshots, jobs };
}

/** Headers shaped like a real Codex response: primary = 5h, secondary = 7d. */
function codexHeaders(fiveHourPct: number, sevenDayPct: number): Headers {
	const resetAtSeconds = Math.floor(Date.now() / 1000) + 3600;
	return new Headers({
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-used-percent": String(fiveHourPct),
		"x-codex-primary-reset-at": String(resetAtSeconds),
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-used-percent": String(sevenDayPct),
		"x-codex-secondary-reset-at": String(resetAtSeconds + 86400),
	});
}

describe("updateAccountMetadata — Codex usage persistence", () => {
	beforeEach(() => {
		resetCodexUsageHistoryThrottle();
		usageCache.delete("codex-acct");
	});

	it("persists the parsed windows for a Codex account", async () => {
		const account = makeCodexAccount();
		const { ctx, snapshots, jobs } = makeCodexCtx();
		const response = new Response("ok", {
			status: 200,
			headers: codexHeaders(41, 63),
		});

		updateAccountMetadata(account, response, ctx);
		// The real AsyncDbWriter is interval-driven; drain by hand.
		for (const job of jobs) await job();

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.accountId).toBe(account.id);
		const usage = snapshots[0]?.usage as Record<
			string,
			{ utilization: number }
		>;
		expect(usage.five_hour?.utilization).toBe(41);
		expect(usage.seven_day?.utilization).toBe(63);
	});
});
