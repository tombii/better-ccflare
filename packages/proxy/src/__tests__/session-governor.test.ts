import { afterEach, describe, expect, test } from "bun:test";
import {
	buildSessionRejectResponse,
	recordSessionRequest,
	resetSessionGovernor,
	SESSION_GOVERNOR_MAX_ENV,
	SESSION_GOVERNOR_WARN_ENV,
	type SessionGovernorVerdict,
} from "../session-governor";

afterEach(() => {
	resetSessionGovernor();
	delete process.env[SESSION_GOVERNOR_MAX_ENV];
	delete process.env[SESSION_GOVERNOR_WARN_ENV];
});

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("recordSessionRequest", () => {
	test("returns null when no session key is present", () => {
		expect(recordSessionRequest(null, T0)).toBeNull();
		expect(recordSessionRequest(undefined, T0)).toBeNull();
		expect(recordSessionRequest("", T0)).toBeNull();
	});

	test("counts requests per session, isolated between sessions", () => {
		recordSessionRequest("s1", T0);
		recordSessionRequest("s2", T0);
		const verdict = recordSessionRequest("s1", T0 + 1_000);
		expect(verdict?.count).toBe(2);
	});

	test("expires requests older than one hour", () => {
		recordSessionRequest("s1", T0);
		const verdict = recordSessionRequest("s1", T0 + HOUR + 60_000);
		expect(verdict?.count).toBe(1);
	});

	test("enforcement is disabled by default", () => {
		let verdict: SessionGovernorVerdict | null = null;
		for (let i = 0; i < 1_200; i++) {
			verdict = recordSessionRequest("s1", T0 + i);
		}
		expect(verdict?.count).toBe(1_200);
		expect(verdict?.rejected).toBe(false);
	});

	test("rejects above the configured hourly budget, other sessions unaffected", () => {
		process.env[SESSION_GOVERNOR_MAX_ENV] = "5";
		for (let i = 0; i < 5; i++) {
			expect(recordSessionRequest("s1", T0 + i)?.rejected).toBe(false);
		}
		expect(recordSessionRequest("s1", T0 + 10)?.rejected).toBe(true);
		expect(recordSessionRequest("s2", T0 + 11)?.rejected).toBe(false);
	});

	test("budget recovers once the window drains", () => {
		process.env[SESSION_GOVERNOR_MAX_ENV] = "2";
		recordSessionRequest("s1", T0);
		recordSessionRequest("s1", T0 + 1);
		expect(recordSessionRequest("s1", T0 + 2)?.rejected).toBe(true);
		expect(recordSessionRequest("s1", T0 + HOUR + 60_000)?.rejected).toBe(
			false,
		);
	});

	test("invalid env values fall back to defaults", () => {
		process.env[SESSION_GOVERNOR_MAX_ENV] = "not-a-number";
		let verdict: SessionGovernorVerdict | null = null;
		for (let i = 0; i < 400; i++) {
			verdict = recordSessionRequest("s1", T0 + i);
		}
		expect(verdict?.rejected).toBe(false);
	});

	test("numeric-prefix env values fall back instead of truncating", () => {
		// parseInt would read "1e5" as 1 and "0x10" as 0; both must be treated
		// as invalid rather than becoming tiny or disabled budgets.
		process.env[SESSION_GOVERNOR_MAX_ENV] = "1e5";
		let verdict: SessionGovernorVerdict | null = null;
		for (let i = 0; i < 10; i++) {
			verdict = recordSessionRequest("s1", T0 + i);
		}
		expect(verdict?.rejected).toBe(false);
		expect(verdict?.maxLimit).toBe(0);

		process.env[SESSION_GOVERNOR_MAX_ENV] = "0x10";
		const next = recordSessionRequest("s1", T0 + 100);
		expect(next?.maxLimit).toBe(0);
	});

	test("rejected requests consume no budget and retry-after is honest", () => {
		process.env[SESSION_GOVERNOR_MAX_ENV] = "3";
		recordSessionRequest("s1", T0);
		recordSessionRequest("s1", T0 + 1_000);
		recordSessionRequest("s1", T0 + 2_000);
		const rejectedVerdict = recordSessionRequest("s1", T0 + 3_000);
		expect(rejectedVerdict?.rejected).toBe(true);
		// The oldest admitted request (T0) leaves the window at T0 + 1h.
		expect(rejectedVerdict?.retryAfterSec).toBe(
			Math.ceil((HOUR - 3_000) / 1000),
		);
		// Retrying while rejected must not extend the lockout: none of these
		// consume budget, so the session recovers when the original burst
		// expires instead of being locked out forever.
		for (let i = 0; i < 50; i++) {
			const retry = recordSessionRequest("s1", T0 + 60_000 * (i + 1));
			expect(retry?.rejected).toBe(true);
		}
		const afterExpiry = recordSessionRequest("s1", T0 + HOUR + 2_500);
		expect(afterExpiry?.rejected).toBe(false);
	});

	test("capacity eviction drops idle sessions before active ones", () => {
		// Fill the tracker to capacity with sessions whose last activity is
		// oldest-first, then keep one hot session current.
		for (let i = 0; i < 2048; i++) {
			recordSessionRequest(`filler-${i}`, T0 + i);
		}
		const hot = recordSessionRequest("hot", T0 + 10_000);
		expect(hot?.count).toBe(1);

		// New sessions past capacity must evict stale fillers, not "hot".
		for (let i = 0; i < 50; i++) {
			recordSessionRequest(`overflow-${i}`, T0 + 11_000 + i);
		}
		const hotAgain = recordSessionRequest("hot", T0 + 12_000);
		expect(hotAgain?.count).toBe(2);
	});
});

describe("buildSessionRejectResponse", () => {
	test("returns an Anthropic-shaped 429 with retry-after", async () => {
		process.env[SESSION_GOVERNOR_MAX_ENV] = "1";
		recordSessionRequest("s1", T0);
		const verdict = recordSessionRequest("s1", T0 + 1);
		expect(verdict?.rejected).toBe(true);
		if (!verdict) throw new Error("verdict missing");

		const res = buildSessionRejectResponse(verdict);
		expect(res.status).toBe(429);
		// The single admitted request (T0) leaves the window one hour later.
		expect(res.headers.get("retry-after")).toBe("3600");
		const body = (await res.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.message).toContain("session budget exceeded");
	});
});
