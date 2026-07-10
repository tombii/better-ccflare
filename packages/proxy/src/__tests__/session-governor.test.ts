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
		expect(res.headers.get("retry-after")).toBe("300");
		const body = (await res.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.message).toContain("session budget exceeded");
	});
});
