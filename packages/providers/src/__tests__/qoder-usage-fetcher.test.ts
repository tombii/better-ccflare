import { afterEach, describe, expect, it, mock } from "bun:test";
import { encodeQoderAccessToken } from "../providers/qoder/auth-flow";
import {
	fetchQoderUsageData,
	getRepresentativeQoderUtilization,
	getRepresentativeQoderWindow,
	mapQoderQuota,
} from "../qoder-usage-fetcher";

const originalFetch = globalThis.fetch;

const QUOTA_URL = "https://openapi.qoder.sh/api/v2/quota/usage";

/** Mock the quota endpoint; returns the recorded Authorization headers + URLs. */
function mockQuota(body: unknown, status = 200) {
	const calls: Array<{ url: string; authorization: string | null }> = [];
	globalThis.fetch = mock(async (input: RequestInfo, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		calls.push({ url, authorization: headers.get("Authorization") });
		return new Response(JSON.stringify(body), {
			status,
			statusText: status === 200 ? "OK" : "Error",
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return calls;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Qoder Usage Fetcher", () => {
	describe("mapQoderQuota", () => {
		it("derives utilization from used/total", () => {
			const mapped = mapQoderQuota({
				total: 200,
				used: 50,
				remaining: 150,
				unit: "credits",
				isQuotaExceeded: false,
			});
			expect(mapped.utilizationPercent).toBeCloseTo(25, 5);
			expect(mapped.remainingCredits).toBe(150);
			expect(mapped.unit).toBe("credits");
		});

		it("clamps utilization at 100", () => {
			const mapped = mapQoderQuota({
				total: 10,
				used: 20,
				remaining: 0,
				unit: "credits",
				isQuotaExceeded: true,
			});
			expect(mapped.utilizationPercent).toBe(100);
			expect(mapped.isQuotaExceeded).toBe(true);
		});

		// A zero-credit account is not out of service: Qoder's free models are
		// served at a zero balance (`billable: false`). Reporting 100% here
		// marked the account usage-exhausted and removed it from the rotation —
		// the exact account this provider exists to serve.
		it("reports no utilization for a zero-credit account, exceeded or not", () => {
			for (const isQuotaExceeded of [true, false]) {
				const mapped = mapQoderQuota({
					total: 0,
					used: 0,
					remaining: 0,
					unit: "credits",
					isQuotaExceeded,
				});
				expect(mapped.utilizationPercent).toBeNull();
				expect(mapped.isQuotaExceeded).toBe(isQuotaExceeded);
			}
		});
	});

	describe("fetchQoderUsageData", () => {
		it("maps a successful quota response", async () => {
			const calls = mockQuota({
				userQuota: { total: 400, used: 100, remaining: 300, unit: "credits" },
				isQuotaExceeded: false,
			});
			const data = await fetchQoderUsageData({
				access_token: encodeQoderAccessToken("pat", "jt-abc"),
			});
			expect(data).not.toBeNull();
			expect(data?.totalCredits).toBe(400);
			expect(data?.usedCredits).toBe(100);
			expect(data?.remainingCredits).toBe(300);
			expect(data?.utilizationPercent).toBeCloseTo(25, 5);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe(QUOTA_URL);
			expect(calls[0]?.authorization).toBe("Bearer jt-abc");
		});

		it("keeps a zero-credit account routable", async () => {
			mockQuota({
				userQuota: { total: 0, used: 0, remaining: 0, unit: "credits" },
				isQuotaExceeded: true,
			});
			const data = await fetchQoderUsageData({ access_token: "jt-abc" });
			expect(data?.isQuotaExceeded).toBe(true);
			// No opinion, not "exhausted": selection falls back to the
			// usage-free check and the account stays in the rotation.
			expect(getRepresentativeQoderUtilization(data)).toBeNull();
		});

		it("accepts a bare job token (no prefix)", async () => {
			const calls = mockQuota({
				userQuota: { total: 10, used: 1, remaining: 9, unit: "credits" },
			});
			const data = await fetchQoderUsageData({ access_token: "jt-bare" });
			expect(data).not.toBeNull();
			expect(calls[0]?.authorization).toBe("Bearer jt-bare");
		});

		it("decodes a prefixed job-refresh-mode token", async () => {
			const calls = mockQuota({
				userQuota: { total: 10, used: 1, remaining: 9, unit: "credits" },
			});
			await fetchQoderUsageData({
				access_token: encodeQoderAccessToken("jrt", "jt-cli"),
			});
			expect(calls[0]?.authorization).toBe("Bearer jt-cli");
		});

		it("returns null for an undecodable prefixed token without calling upstream", async () => {
			const calls = mockQuota({});
			expect(
				await fetchQoderUsageData({ access_token: "__qoder_jwt.bogus" }),
			).toBeNull();
			expect(calls).toHaveLength(0);
		});

		it("returns null for a missing token", async () => {
			const calls = mockQuota({});
			expect(await fetchQoderUsageData(null)).toBeNull();
			expect(await fetchQoderUsageData({})).toBeNull();
			expect(calls).toHaveLength(0);
		});

		it("returns null on a non-OK response", async () => {
			mockQuota({ error: "unauthorized" }, 401);
			expect(await fetchQoderUsageData("jt-abc")).toBeNull();
		});

		it("reads the quota from the OpenAPI host of a CN-region account", async () => {
			const calls = mockQuota({
				userQuota: { total: 10, used: 1, remaining: 9, unit: "credits" },
			});
			// The account names the GATEWAY host; the quota lives on the OpenAPI
			// host, which the fetcher derives from it.
			await fetchQoderUsageData({
				access_token: "jt-abc",
				custom_endpoint: "https://gateway.qoder.com.cn",
			});
			expect(calls[0]?.url).toBe(
				"https://openapi.qoder.com.cn/api/v2/quota/usage",
			);
		});

		it("reads the quota from an explicit OpenAPI host", async () => {
			const calls = mockQuota({
				userQuota: { total: 10, used: 1, remaining: 9, unit: "credits" },
			});
			await fetchQoderUsageData({
				access_token: "jt-abc",
				custom_endpoint: JSON.stringify({
					endpoint: "https://gateway.qoder.com.cn",
					openapiEndpoint: "https://openapi.example.com",
				}),
			});
			expect(calls[0]?.url).toBe(
				"https://openapi.example.com/api/v2/quota/usage",
			);
		});

		it("returns null on a network error", async () => {
			globalThis.fetch = mock(async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch;
			expect(await fetchQoderUsageData("jt-abc")).toBeNull();
		});
	});

	describe("representative helpers", () => {
		it("returns null utilization and a credits label for no data", () => {
			expect(getRepresentativeQoderUtilization(null)).toBeNull();
			expect(getRepresentativeQoderWindow(null)).toBe("credits");
		});
	});
});
