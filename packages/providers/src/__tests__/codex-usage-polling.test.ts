import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { supportsUsageTracking } from "@better-ccflare/types";
import { CODEX_USAGE_ENDPOINT } from "../providers/codex/usage-endpoint";
import { type UsageData, usageCache } from "../usage-fetcher";

const ACCOUNT_ID = "codex-polling-test-account";
const ONE_HOUR_MS = 60 * 60 * 1000;

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const TOKEN = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
	"https://api.openai.com/auth": { chatgpt_account_id: "acct_poll" },
})}.sig`;

function payload(fiveHourPercent = 12, weeklyPercent = 43) {
	const nowS = Math.floor(Date.now() / 1000);
	return {
		plan_type: "plus",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: fiveHourPercent,
				limit_window_seconds: 18_000,
				reset_after_seconds: 9_000,
				reset_at: nowS + 9_000,
			},
			secondary_window: {
				used_percent: weeklyPercent,
				limit_window_seconds: 604_800,
				reset_after_seconds: 500_000,
				reset_at: nowS + 500_000,
			},
		},
	};
}

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

describe("usageCache polling for codex", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		usageCache.stopPolling(ACCOUNT_ID);
		globalThis.fetch = originalFetch;
	});

	it("is enabled in PROVIDER_CONFIG", () => {
		expect(supportsUsageTracking("codex")).toBe(true);
	});

	it("polls the ChatGPT usage endpoint with the account id header and caches both windows", async () => {
		const seenHeaders: Record<string, string>[] = [];
		const fetchMock = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(CODEX_USAGE_ENDPOINT);
				seenHeaders.push(init?.headers as Record<string, string>);
				return okResponse(payload());
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
		);
		const refreshed = await usageCache.refreshNow(ACCOUNT_ID);

		expect(refreshed).toBe(true);
		expect(fetchMock).toHaveBeenCalled();
		expect(seenHeaders[0]["ChatGPT-Account-Id"]).toBe("acct_poll");
		expect(seenHeaders[0].Authorization).toBe(`Bearer ${TOKEN}`);
		const cached = usageCache.get(ACCOUNT_ID) as UsageData | null;
		expect(cached?.five_hour?.utilization).toBe(12);
		expect(cached?.seven_day?.utilization).toBe(43);
		expect(usageCache.getRateLimitedUntil(ACCOUNT_ID)).toBeNull();
	});

	it("caches a weekly-only payload without a five_hour key", async () => {
		const body = payload();
		body.rate_limit.primary_window = null as never;
		globalThis.fetch = mock(async () =>
			okResponse(body),
		) as unknown as typeof fetch;

		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
		);
		await usageCache.refreshNow(ACCOUNT_ID);

		const cached = usageCache.get(ACCOUNT_ID) as UsageData | null;
		expect(cached?.seven_day?.utilization).toBe(43);
		expect(cached?.five_hour).toBeUndefined();
	});

	it("fires the snapshot callback with the polled payload", async () => {
		globalThis.fetch = mock(async () =>
			okResponse(payload()),
		) as unknown as typeof fetch;
		const snapshots: UsageData[] = [];

		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
			undefined,
			undefined,
			undefined,
			undefined,
			(_accountId, data) => {
				snapshots.push(data);
			},
		);
		await usageCache.refreshNow(ACCOUNT_ID);

		expect(snapshots.length).toBeGreaterThan(0);
		expect(snapshots[0].seven_day?.utilization).toBe(43);
	});

	it("records a 429 Retry-After as usageRateLimitedUntil and caches nothing", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response("slow down", {
					status: 429,
					headers: { "retry-after": "120" },
				}),
		) as unknown as typeof fetch;

		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
		);
		const refreshed = await usageCache.refreshNow(ACCOUNT_ID);

		expect(refreshed).toBe(false);
		const until = usageCache.getRateLimitedUntil(ACCOUNT_ID);
		expect(until).not.toBeNull();
		expect((until as number) - Date.now()).toBeGreaterThan(100_000);
		expect(usageCache.get(ACCOUNT_ID)).toBeNull();
	});

	it("marks a rate limit on a 429 without a Retry-After header", async () => {
		globalThis.fetch = mock(
			async () => new Response("slow down", { status: 429 }),
		) as unknown as typeof fetch;

		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
		);
		const refreshed = await usageCache.refreshNow(ACCOUNT_ID);

		expect(refreshed).toBe(false);
		const until = usageCache.getRateLimitedUntil(ACCOUNT_ID);
		expect(until).not.toBeNull();
		expect((until as number) - Date.now()).toBeGreaterThan(30_000);
	});

	it("does not mark a rate limit on a 403", async () => {
		globalThis.fetch = mock(
			async () => new Response("forbidden", { status: 403 }),
		) as unknown as typeof fetch;

		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
		);
		const refreshed = await usageCache.refreshNow(ACCOUNT_ID);

		expect(refreshed).toBe(false);
		expect(usageCache.getRateLimitedUntil(ACCOUNT_ID)).toBeNull();
		expect(usageCache.get(ACCOUNT_ID)).toBeNull();
	});
});

describe("codex polling and window rollovers", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.resetCodexRolloverPolicy();
		globalThis.fetch = originalFetch;
	});

	/** A 5-hour window at `percent` used, resetting `resetInMs` from now. */
	function fiveHourPayload(percent: number, resetInMs: number) {
		return {
			plan_type: "plus",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: percent,
					limit_window_seconds: 18_000,
					reset_at: Math.floor((Date.now() + resetInMs) / 1000),
				},
				secondary_window: null,
			},
		};
	}

	function seedBaseline(percent: number, resetInMs: number): void {
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: percent,
				resets_at: new Date(Date.now() + resetInMs).toISOString(),
			},
		} as UsageData);
	}

	async function pollOnce(
		body: unknown,
		onWindowReset: (accountId: string) => void,
	): Promise<void> {
		globalThis.fetch = mock(async () =>
			okResponse(body),
		) as unknown as typeof fetch;
		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
			undefined,
			onWindowReset,
		);
		await usageCache.refreshNow(ACCOUNT_ID);
	}

	it("does not reset the session when the 5-hour deadline slides forward", async () => {
		// OpenAI pushes resets_at forward while the account sits idle. The old
		// ">60s advance" rule fired on nearly every poll here.
		const onWindowReset = mock((_accountId: string) => {});
		seedBaseline(20, ONE_HOUR_MS);

		await pollOnce(fiveHourPayload(25, 2 * ONE_HOUR_MS), onWindowReset);

		expect(onWindowReset).not.toHaveBeenCalled();
		const cached = usageCache.get(ACCOUNT_ID) as UsageData | null;
		expect(cached?.five_hour?.utilization).toBe(25);
	});

	it("does not reset the session when utilization keeps rising past the deadline", async () => {
		const onWindowReset = mock((_accountId: string) => {});
		seedBaseline(20, -60_000);

		await pollOnce(fiveHourPayload(25, 5 * ONE_HOUR_MS), onWindowReset);

		expect(onWindowReset).not.toHaveBeenCalled();
	});

	it("resets the session once on a real rollover", async () => {
		const onWindowReset = mock((_accountId: string) => {});
		seedBaseline(80, -60_000);

		await pollOnce(fiveHourPayload(5, 5 * ONE_HOUR_MS), onWindowReset);

		expect(onWindowReset).toHaveBeenCalledTimes(1);
		expect(onWindowReset.mock.calls[0][0]).toBe(ACCOUNT_ID);
	});

	it("discards a poll whose payload lost the race against the traffic path", async () => {
		// The poller reads the pre-rollover window; while that GET is on the
		// wire a real response makes response-processor.ts detect the rollover,
		// reset the session and write the fresh window through usageCache.set.
		// The late poll must not put the expired window back — that both
		// rewinds the dashboard and makes the NEXT poll look like a second
		// rollover of the same window.
		const onWindowReset = mock((_accountId: string) => {});
		seedBaseline(80, -60_000);

		let releaseFetch: (() => void) | undefined;
		const fetchReleased = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		globalThis.fetch = mock(async () => {
			markFetchStarted?.();
			await fetchReleased;
			// Stale: the 5-hour window as it stood before the rollover.
			return okResponse(fiveHourPayload(80, -60_000));
		}) as unknown as typeof fetch;

		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
			undefined,
			onWindowReset,
		);
		const pending = usageCache.refreshNow(ACCOUNT_ID);
		await fetchStarted;

		// The traffic path wins the race.
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 5,
				resets_at: new Date(Date.now() + 5 * ONE_HOUR_MS).toISOString(),
			},
		} as UsageData);

		releaseFetch?.();
		await pending;

		const cached = usageCache.get(ACCOUNT_ID) as UsageData | null;
		expect(cached?.five_hour?.utilization).toBe(5);
		expect(onWindowReset).not.toHaveBeenCalled();

		// And the next poll, seeing the same fresh window, must not read the
		// discarded payload as a baseline and fire a duplicate rollover.
		globalThis.fetch = mock(async () =>
			okResponse(fiveHourPayload(5, 5 * ONE_HOUR_MS)),
		) as unknown as typeof fetch;
		await usageCache.refreshNow(ACCOUNT_ID);

		expect(onWindowReset).not.toHaveBeenCalled();
	});
});

describe("codex polling and the configured rollover window", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.resetCodexRolloverPolicy();
		globalThis.fetch = originalFetch;
	});

	function weeklyOnlyPayload(percent: number, resetInMs: number) {
		return {
			plan_type: "pro",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: percent,
					limit_window_seconds: 604_800,
					reset_at: Math.floor((Date.now() + resetInMs) / 1000),
				},
				secondary_window: null,
			},
		};
	}

	function seedWeeklyBaseline(percent: number, resetInMs: number): void {
		usageCache.set(ACCOUNT_ID, {
			seven_day: {
				utilization: percent,
				resets_at: new Date(Date.now() + resetInMs).toISOString(),
			},
		} as UsageData);
	}

	async function pollWeekly(
		onWindowReset: (accountId: string) => void,
	): Promise<void> {
		globalThis.fetch = mock(async () =>
			okResponse(weeklyOnlyPayload(5, 5 * ONE_HOUR_MS)),
		) as unknown as typeof fetch;
		usageCache.startPolling(
			ACCOUNT_ID,
			async () => TOKEN,
			"codex",
			ONE_HOUR_MS,
			undefined,
			onWindowReset,
		);
		await usageCache.refreshNow(ACCOUNT_ID);
	}

	it("rides the weekly window by default, as the traffic path does", async () => {
		const onWindowReset = mock((_accountId: string) => {});
		seedWeeklyBaseline(80, -60_000);

		await pollWeekly(onWindowReset);

		expect(onWindowReset).toHaveBeenCalledTimes(1);
	});

	it("stays pinned to the 5-hour window when the policy says so", async () => {
		// CODEX_FIVE_HOUR_WINDOW_ENABLED keeps the session on the 5-hour
		// window. A weekly-only payload then has nothing to compare, so the
		// poller must reach the same verdict as response-processor.ts.
		const onWindowReset = mock((_accountId: string) => {});
		usageCache.setCodexRolloverPolicy({ pinFiveHour: () => true });
		seedWeeklyBaseline(80, -60_000);

		await pollWeekly(onWindowReset);

		expect(onWindowReset).not.toHaveBeenCalled();
	});
});
