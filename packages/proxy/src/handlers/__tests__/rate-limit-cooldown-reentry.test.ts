import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	computeRateLimitBackoffMs,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import {
	applyRateLimitCooldown,
	completeRateLimitProbe,
	getRateLimitProbeAdmission,
	resetRateLimitProbeGatesForTests,
} from "../rate-limit-cooldown";

const NOW = Date.UTC(2026, 6, 9, 3, 0, 0);
const realDateNow = Date.now;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "mature-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: NOW + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

function makeCtx(opts: { rateLimited: boolean; resetTime?: number }) {
	const calls = {
		markRateLimited: [] as Array<{
			until: number;
			reason: string;
			incrementStreak?: boolean;
		}>,
	};
	const ctx = {
		provider: {
			name: "anthropic",
			parseRateLimit: () => ({
				isRateLimited: opts.rateLimited,
				resetTime: opts.resetTime,
				statusHeader: opts.rateLimited ? "rate_limited" : undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		},
		dbOps: {
			markAccountRateLimited: async (
				_accountId: string,
				until: number,
				reason: string,
				incrementStreak?: boolean,
			) => {
				calls.markRateLimited.push({ until, reason, incrementStreak });
				return 9;
			},
			updateAccountUsage: mock(() => {}),
			updateAccountRateLimitMeta: mock(() => {}),
			getAdapter: () => ({ run: async () => {} }),
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => void job(),
		},
	} as unknown as ProxyContext;
	return { ctx, calls };
}

afterEach(() => {
	Date.now = realDateNow;
	resetRateLimitProbeGatesForTests();
});

describe("mature cooldown re-entry / single-flight probe", () => {
	it("does not gate ordinary accounts (below the mature streak threshold)", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 4,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
	});

	it("does not gate accounts still within an active cooldown window", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW + 60_000,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("not_required");
	});

	it("treats the exact cooldown boundary as expired", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("admits only one concurrent probe for a mature expired cooldown", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		// A second concurrent request selecting the same account is suppressed
		// and must fall through to the next account instead of stampeding it.
		expect(getRateLimitProbeAdmission(account)).toBe("suppressed");
		expect(getRateLimitProbeAdmission(account)).toBe("suppressed");
	});

	it("releases the probe lease when the probe succeeds", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		completeRateLimitProbe(account, "recovered");
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("releases the probe lease when cooldown is reapplied via a fresh 429", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		const { ctx } = makeCtx({ rateLimited: true });

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		applyRateLimitCooldown(account, { resetTime: NOW + 120_000 }, ctx);
		Date.now = () => NOW + 120_001;

		// The reapplied cooldown released the old lease. Once it expires again,
		// and the streak is still mature, a fresh probe is admitted.
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("releases an abandoned probe immediately", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		completeRateLimitProbe(account, "abandoned");
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("self-heals a leaked probe after the bounded lease window expires", () => {
		Date.now = () => NOW;
		const account = makeAccount({
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});

		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
		// Never completed, simulating a crash or unhandled path. Self-heals once
		// the lease window elapses.
		Date.now = () => NOW + 120_001;
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");
	});

	it("evicts the oldest lease once the in-memory map hits the cap", () => {
		Date.now = () => NOW;
		const first = makeAccount({
			id: "acc-evict-me",
			consecutive_rate_limits: 9,
			rate_limited_until: NOW - 1,
		});
		expect(getRateLimitProbeAdmission(first)).toBe("admitted");

		// Fill the map with distinct accounts up to the eviction cap so the
		// oldest lease (acc-evict-me) gets pruned.
		const MAX_PROBE_GATES = 10_000;
		for (let i = 0; i < MAX_PROBE_GATES; i++) {
			const acct = makeAccount({
				id: `acc-fill-${i}`,
				consecutive_rate_limits: 9,
				rate_limited_until: NOW - 1,
			});
			getRateLimitProbeAdmission(acct);
		}

		// The original account's lease was evicted, so a fresh probe is admitted
		// again instead of being suppressed.
		expect(getRateLimitProbeAdmission(first)).toBe("admitted");
	});
});

describe("529 overload cooldown separation", () => {
	it("applies the fixed overload cooldown for a reset-less 529, ignoring the 429 streak depth", () => {
		Date.now = () => NOW;
		// A mature 429 streak would normally ramp the exponential backoff to
		// minutes; a 529 overload must ignore that ramp entirely.
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx } = makeCtx({ rateLimited: true });

		applyRateLimitCooldown(
			account,
			{ reason: "upstream_529_overloaded_no_reset" },
			ctx,
		);

		expect(account.rate_limited_until).toBe(
			NOW + TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
	});

	it("does not increment consecutive_rate_limits after a 529 overload, in-memory or via the DB call", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx, calls } = makeCtx({ rateLimited: true });

		applyRateLimitCooldown(
			account,
			{ reason: "upstream_529_overloaded_no_reset" },
			ctx,
		);

		expect(account.consecutive_rate_limits).toBe(8);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.incrementStreak).toBe(false);
	});

	it("keeps the reset-driven cooldown duration for a 529-with-reset, but still suppresses the streak (upstream ccflare#271)", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx, calls } = makeCtx({ rateLimited: true });
		// Anthropic's real retry-after for the with-reset path (production incident: 60s).
		const resetTime = NOW + 60_000;

		applyRateLimitCooldown(
			account,
			{ resetTime, reason: "upstream_529_overloaded_with_reset" },
			ctx,
		);

		// Duration formula is untouched — min(resetTime, now + exponential-ramp) —
		// so Anthropic's retry-after is honored exactly as for a normal 429. It
		// must NOT be shortened to the fixed reset-less overload cooldown.
		expect(account.rate_limited_until).toBe(
			Math.min(resetTime, NOW + computeRateLimitBackoffMs(9)),
		);
		// The streak itself stays untouched — a 529 is not a quota signal, even
		// when it does carry a reset.
		expect(account.consecutive_rate_limits).toBe(8);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.incrementStreak).toBe(false);
	});

	it("keeps the exponential 429 ramp and reset-time cap unchanged (regression)", () => {
		Date.now = () => NOW;
		const account = makeAccount({ consecutive_rate_limits: 8 });
		const { ctx, calls } = makeCtx({ rateLimited: true });
		// Shorter than the 8th-streak backoff ceiling, so it drives the cap.
		const resetTime = NOW + 10_000;

		applyRateLimitCooldown(
			account,
			{ resetTime, reason: "upstream_429_no_reset_probe_cooldown" },
			ctx,
		);

		expect(account.consecutive_rate_limits).toBe(9);
		expect(account.rate_limited_until).toBe(
			Math.min(resetTime, NOW + computeRateLimitBackoffMs(9)),
		);
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.incrementStreak).toBe(true);
	});
});
