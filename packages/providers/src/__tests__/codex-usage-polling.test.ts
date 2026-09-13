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
