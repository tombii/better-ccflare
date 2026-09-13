import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CODEX_USER_AGENT } from "./provider";
import {
	CODEX_USAGE_ENDPOINT,
	fetchCodexUsageData,
	parseCodexUsagePayload,
	readCodexPlanType,
} from "./usage-endpoint";

const NOW_MS = 1_789_300_000_000; // 2026-09-13T11:46:40.000Z
const NOW_S = NOW_MS / 1000;
const FIVE_HOUR_S = 5 * 60 * 60;
const SEVEN_DAY_S = 7 * 24 * 60 * 60;

function window(
	overrides: Partial<{
		used_percent: number;
		limit_window_seconds: number;
		reset_after_seconds: number;
		reset_at: number;
	}> = {},
) {
	return {
		used_percent: 12,
		limit_window_seconds: FIVE_HOUR_S,
		reset_after_seconds: 9_000,
		reset_at: NOW_S + 9_000,
		...overrides,
	};
}

function payload(
	primary: unknown = window(),
	secondary: unknown = window({
		used_percent: 43,
		limit_window_seconds: SEVEN_DAY_S,
		reset_after_seconds: 500_000,
		reset_at: NOW_S + 500_000,
	}),
	planType = "plus",
) {
	return {
		plan_type: planType,
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: primary,
			secondary_window: secondary,
		},
		credits: { has_credits: false, unlimited: false, balance: null },
		additional_rate_limits: [],
		rate_limit_reached_type: null,
	};
}

describe("parseCodexUsagePayload", () => {
	it("maps primary/secondary windows into five_hour/seven_day by window length", () => {
		const usage = parseCodexUsagePayload(payload(), NOW_MS);

		expect(usage).toEqual({
			five_hour: {
				utilization: 12,
				resets_at: new Date((NOW_S + 9_000) * 1000).toISOString(),
			},
			seven_day: {
				utilization: 43,
				resets_at: new Date((NOW_S + 500_000) * 1000).toISOString(),
			},
		});
	});

	it("slots by limit_window_seconds, not by primary/secondary position", () => {
		const weekly = window({
			used_percent: 43,
			limit_window_seconds: SEVEN_DAY_S,
			reset_at: NOW_S + 500_000,
		});
		const fiveHour = window({ used_percent: 7, reset_at: NOW_S + 100 });

		const usage = parseCodexUsagePayload(payload(weekly, fiveHour), NOW_MS);

		expect(usage?.five_hour?.utilization).toBe(7);
		expect(usage?.seven_day?.utilization).toBe(43);
	});

	it("omits five_hour when only the weekly window is reported (Pro accounts)", () => {
		const usage = parseCodexUsagePayload(
			payload(
				null,
				window({ used_percent: 43, limit_window_seconds: SEVEN_DAY_S }),
			),
			NOW_MS,
		);

		expect(Object.keys(usage ?? {})).toEqual(["seven_day"]);
		expect(usage?.five_hour).toBeUndefined();
	});

	it("falls back to now + reset_after_seconds when reset_at is missing", () => {
		const usage = parseCodexUsagePayload(
			payload(
				{
					used_percent: 5,
					limit_window_seconds: FIVE_HOUR_S,
					reset_after_seconds: 600,
				},
				null,
			),
			NOW_MS,
		);

		expect(usage?.five_hour?.resets_at).toBe(
			new Date(NOW_MS + 600 * 1000).toISOString(),
		);
	});

	it("ignores windows whose length is neither 5 hours nor a week", () => {
		const usage = parseCodexUsagePayload(
			payload(window({ limit_window_seconds: 24 * 60 * 60 }), null),
			NOW_MS,
		);

		expect(usage).toBeNull();
	});

	it("slots any window up to five hours as five_hour, like the header parser", () => {
		const usage = parseCodexUsagePayload(
			payload(window({ used_percent: 3, limit_window_seconds: 3_600 }), null),
			NOW_MS,
		);

		expect(usage?.five_hour?.utilization).toBe(3);
		expect(usage?.seven_day).toBeUndefined();
	});

	it("drops a window without a numeric used_percent instead of minting 0%", () => {
		const usage = parseCodexUsagePayload(
			payload(
				{ limit_window_seconds: FIVE_HOUR_S, reset_at: NOW_S + 100 },
				null,
			),
			NOW_MS,
		);

		expect(usage).toBeNull();
	});

	it("clamps used_percent into 0..100", () => {
		const usage = parseCodexUsagePayload(
			payload(window({ used_percent: 140 }), null),
			NOW_MS,
		);

		expect(usage?.five_hour?.utilization).toBe(100);
	});

	it("falls back to reset_after_seconds when reset_at is outside the valid Date range", () => {
		const usage = parseCodexUsagePayload(
			payload(
				window({ used_percent: 9, reset_at: 1e15, reset_after_seconds: 600 }),
				null,
			),
			NOW_MS,
		);

		expect(usage?.five_hour?.utilization).toBe(9);
		expect(usage?.five_hour?.resets_at).toBe(
			new Date(NOW_MS + 600 * 1000).toISOString(),
		);
	});

	it("keeps the percentage with a null reset when every reset field is out of range, instead of throwing", () => {
		const usage = parseCodexUsagePayload(
			payload(
				window({ used_percent: 9, reset_at: 1e15, reset_after_seconds: 1e15 }),
				null,
			),
			NOW_MS,
		);

		expect(usage).toEqual({ five_hour: { utilization: 9, resets_at: null } });
	});

	it("returns null for bodies without rate_limit", () => {
		expect(parseCodexUsagePayload({ plan_type: "plus" }, NOW_MS)).toBeNull();
		expect(parseCodexUsagePayload({ rate_limit: null }, NOW_MS)).toBeNull();
		expect(parseCodexUsagePayload("nope", NOW_MS)).toBeNull();
		expect(parseCodexUsagePayload(null, NOW_MS)).toBeNull();
	});
});

describe("readCodexPlanType", () => {
	it("returns plan_type when it is a string, otherwise null", () => {
		expect(readCodexPlanType(payload())).toBe("plus");
		expect(readCodexPlanType({ plan_type: 3 })).toBeNull();
		expect(readCodexPlanType(null)).toBeNull();
	});
});

describe("fetchCodexUsageData", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("GETs the usage endpoint with the Codex CLI's headers and returns the mapped windows", async () => {
		const fetchMock = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(CODEX_USAGE_ENDPOINT);
				expect(init?.method).toBe("GET");
				const headers = init?.headers as Record<string, string>;
				expect(headers.Authorization).toBe("Bearer tok-1");
				expect(headers["ChatGPT-Account-Id"]).toBe("acct_1");
				expect(headers["User-Agent"]).toBe(CODEX_USER_AGENT);
				expect(headers.originator).toBe("codex_cli_rs");
				expect(headers.Accept).toBe("application/json");
				return new Response(JSON.stringify(payload()), { status: 200 });
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData(" tok-1 ", {
			chatgptAccountId: "acct_1",
			now: () => NOW_MS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(200);
		expect(result.planType).toBe("plus");
		expect(result.retryAfterMs).toBeNull();
		expect(result.data?.five_hour?.utilization).toBe(12);
		expect(result.data?.seven_day?.utilization).toBe(43);
	});

	it("omits the ChatGPT-Account-Id header when no id is known", async () => {
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = init?.headers as Record<string, string>;
				expect("ChatGPT-Account-Id" in headers).toBe(false);
				return new Response(JSON.stringify(payload()), { status: 200 });
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData("tok-1", { now: () => NOW_MS });

		expect(result.data).not.toBeNull();
	});

	it("returns retryAfterMs from a 429 Retry-After header (seconds)", async () => {
		const fetchMock = mock(
			async () =>
				new Response("slow down", {
					status: 429,
					headers: { "retry-after": "30" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData("tok-1", { now: () => NOW_MS });

		expect(result.data).toBeNull();
		expect(result.status).toBe(429);
		expect(result.retryAfterMs).toBe(30_000);
	});

	it("returns retryAfterMs from a 429 Retry-After header (HTTP date)", async () => {
		const retryAt = new Date(NOW_MS + 45_000).toUTCString();
		const fetchMock = mock(
			async () =>
				new Response("slow down", {
					status: 429,
					headers: { "retry-after": retryAt },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData("tok-1", { now: () => NOW_MS });

		// toUTCString drops milliseconds, so allow a one-second rounding slack.
		expect(result.retryAfterMs).toBeGreaterThanOrEqual(44_000);
		expect(result.retryAfterMs).toBeLessThanOrEqual(45_000);
	});

	it("defaults retryAfterMs to 60 s on a 429 without Retry-After", async () => {
		const fetchMock = mock(
			async () => new Response("slow down", { status: 429 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData("tok-1", { now: () => NOW_MS });

		expect(result.data).toBeNull();
		expect(result.status).toBe(429);
		// A 429 with an unusable Retry-After is still a 429 — without a marker
		// the poller would hammer the endpoint on its normal 90 s cadence.
		expect(result.retryAfterMs).toBe(60_000);
	});

	it("returns null data with the status on 401/403 and no retryAfterMs", async () => {
		for (const status of [401, 403, 500]) {
			const fetchMock = mock(async () => new Response("denied", { status }));
			globalThis.fetch = fetchMock as unknown as typeof fetch;

			const result = await fetchCodexUsageData("tok-1", { now: () => NOW_MS });

			expect(result.data).toBeNull();
			expect(result.status).toBe(status);
			expect(result.retryAfterMs).toBeNull();
		}
	});

	it("returns null data when the body is not JSON", async () => {
		const fetchMock = mock(
			async () => new Response("<html>login</html>", { status: 200 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData("tok-1", { now: () => NOW_MS });

		expect(result.data).toBeNull();
		expect(result.status).toBe(200);
	});

	it("aborts via AbortController and returns status 0 on a network failure", async () => {
		let observedSignal: AbortSignal | undefined;
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				observedSignal = init?.signal ?? undefined;
				throw new DOMException("aborted", "AbortError");
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchCodexUsageData("tok-1", { now: () => NOW_MS });

		expect(observedSignal).toBeInstanceOf(AbortSignal);
		expect(result.data).toBeNull();
		expect(result.status).toBe(0);
	});

	it("honours a custom endpoint override", async () => {
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("https://example.test/backend-api/wham/usage");
			return new Response(JSON.stringify(payload()), { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await fetchCodexUsageData("tok-1", {
			endpoint: "https://example.test/backend-api/wham/usage",
			now: () => NOW_MS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
