import { afterEach, describe, expect, it, mock } from "bun:test";
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
		markRateLimited: [] as Array<{ until: number; reason: string }>,
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
			) => {
				calls.markRateLimited.push({ until, reason });
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
