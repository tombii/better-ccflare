import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	fetchTokenHarborUsageData,
	getTokenHarborRepresentativeUtilization,
	getTokenHarborResetMs,
	parseTokenHarborUsageData,
} from "../tokenharbor-usage-fetcher";

/** Real payload verified 2026-11-26. */
const USAGE_BODY = {
	plan_name: "Agent Pass",
	models: [
		"deepseek-v4-flash",
		"mimo-v2.6-flash",
		"mimo-v2.5",
		"deepseek-v4.1-flash",
	],
	models_enabled: true,
	on_plan: true,
	campaign: false,
	req_used: 0,
	reset_at: "2026-12-03T09:05:44.382+00:00",
	unlocked: false,
	used_pct: 0,
	activated: true,
	exhausted: false,
	rpm_limit: 1000000,
	buffer_pct: 0,
	plan_used_pct: 0,
	base_share_pct: 100,
	campaign_label: "",
	period_ends_at: "2026-12-03T09:05:44.382+00:00",
	plan_exhausted: false,
	period_started_at: "2026-11-26T09:05:44.382+00:00",
};

describe("TokenHarbor usage fetcher", () => {
	let originalFetch: typeof fetch;
	let requestedUrl: string | null;
	let requestedInit: RequestInit | undefined;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		requestedUrl = null;
		requestedInit = undefined;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function stubFetch(body: unknown, status = 200): void {
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			requestedUrl = String(url);
			requestedInit = init;
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
	}

	it("parses the real payload and sends Bearer auth", async () => {
		stubFetch(USAGE_BODY);

		const usage = await fetchTokenHarborUsageData("secret-key");

		expect(usage).toMatchObject({
			plan_name: "Agent Pass",
			on_plan: true,
			plan_used_pct: 0,
			used_pct: 0,
			reset_at: "2026-12-03T09:05:44.382+00:00",
		});
		expect(usage?.models).toHaveLength(4);
		expect(requestedUrl).toBe("https://tokenharbor.ai/api/cli/free-tier");
		expect(
			(requestedInit?.headers as Record<string, string>).Authorization,
		).toBe("Bearer secret-key");
	});

	it("derives the usage path from the account's custom endpoint", async () => {
		stubFetch(USAGE_BODY);

		await fetchTokenHarborUsageData("key", "https://mirror.example");

		expect(requestedUrl).toBe("https://mirror.example/api/cli/free-tier");
	});

	it("returns null on HTTP 401", async () => {
		stubFetch({ error: "unauthorized" }, 401);

		expect(await fetchTokenHarborUsageData("key")).toBeNull();
	});

	it("returns null on a malformed body", async () => {
		stubFetch({ plan_name: "Agent Pass", used_pct: "lots" });

		expect(await fetchTokenHarborUsageData("key")).toBeNull();
	});

	it("returns null when fetch throws", async () => {
		globalThis.fetch = (() => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		expect(await fetchTokenHarborUsageData("key")).toBeNull();
	});

	it("keeps a null reset_at without failing the payload", () => {
		const parsed = parseTokenHarborUsageData({
			...USAGE_BODY,
			reset_at: null,
			period_ends_at: null,
		});

		expect(parsed?.reset_at).toBeNull();
		expect(getTokenHarborResetMs(parsed)).toBeNull();
	});

	it("rejects a non-string reset_at", () => {
		expect(
			parseTokenHarborUsageData({ ...USAGE_BODY, reset_at: 12345 }),
		).toBeNull();
	});

	it("budgets by the Pass on a plan and by free models otherwise", () => {
		expect(
			getTokenHarborRepresentativeUtilization({
				...USAGE_BODY,
				on_plan: true,
				plan_used_pct: 40,
				used_pct: 90,
			}),
		).toBe(40);
		expect(
			getTokenHarborRepresentativeUtilization({
				...USAGE_BODY,
				on_plan: false,
				plan_used_pct: 40,
				used_pct: 90,
			}),
		).toBe(90);
	});

	it("clamps the representative utilization to 0..100", () => {
		expect(
			getTokenHarborRepresentativeUtilization({
				...USAGE_BODY,
				on_plan: true,
				plan_used_pct: 140,
			}),
		).toBe(100);
		expect(
			getTokenHarborRepresentativeUtilization({
				...USAGE_BODY,
				on_plan: true,
				plan_used_pct: -5,
			}),
		).toBe(0);
	});

	it("parses the shared 7-day reset to epoch ms", () => {
		expect(getTokenHarborResetMs(USAGE_BODY)).toBe(
			Date.parse("2026-12-03T09:05:44.382+00:00"),
		);
	});
});
