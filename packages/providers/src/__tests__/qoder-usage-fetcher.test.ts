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

		it("reports 100% when an exceeded quota has no total", () => {
			const mapped = mapQoderQuota({
				total: 0,
				used: 0,
				remaining: 0,
				unit: "credits",
				isQuotaExceeded: true,
			});
			expect(mapped.utilizationPercent).toBe(100);
		});

		it("reports 0% when a quota with no total is not exceeded", () => {
			const mapped = mapQoderQuota({
				total: 0,
				used: 0,
				remaining: 0,
				unit: "credits",
				isQuotaExceeded: false,
			});
			expect(mapped.utilizationPercent).toBe(0);
		});
	});

	describe("fetchQoderUsageData", () => {
		it("maps a successful quota response", async () => {
			const calls = mockQuota({
				userQuota: { total: 400, used: 100, remaining: 300, unit: "credits" },
				isQuotaExceeded: false,
			});
			const data = await fetchQoderUsageData(
				encodeQoderAccessToken("pat", "jt-abc"),
			);
			expect(data).not.toBeNull();
			expect(data?.totalCredits).toBe(400);
			expect(data?.usedCredits).toBe(100);
			expect(data?.remainingCredits).toBe(300);
			expect(data?.utilizationPercent).toBeCloseTo(25, 5);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe(QUOTA_URL);
			expect(calls[0]?.authorization).toBe("Bearer jt-abc");
		});

		it("carries isQuotaExceeded through to 100% utilization", async () => {
			mockQuota({
				userQuota: { total: 0, used: 0, remaining: 0, unit: "credits" },
				isQuotaExceeded: true,
			});
			const data = await fetchQoderUsageData("jt-abc");
			expect(data?.isQuotaExceeded).toBe(true);
			expect(getRepresentativeQoderUtilization(data)).toBe(100);
		});

		it("accepts a bare job token (no prefix)", async () => {
			const calls = mockQuota({
				userQuota: { total: 10, used: 1, remaining: 9, unit: "credits" },
			});
			const data = await fetchQoderUsageData("jt-bare");
			expect(data).not.toBeNull();
			expect(calls[0]?.authorization).toBe("Bearer jt-bare");
		});

		it("decodes a prefixed job-refresh-mode token", async () => {
			const calls = mockQuota({
				userQuota: { total: 10, used: 1, remaining: 9, unit: "credits" },
			});
			await fetchQoderUsageData(encodeQoderAccessToken("jrt", "jt-cli"));
			expect(calls[0]?.authorization).toBe("Bearer jt-cli");
		});

		it("returns null for an undecodable prefixed token without calling upstream", async () => {
			const calls = mockQuota({});
			expect(await fetchQoderUsageData("__qoder_jwt.bogus")).toBeNull();
			expect(calls).toHaveLength(0);
		});

		it("returns null for a missing token", async () => {
			const calls = mockQuota({});
			expect(await fetchQoderUsageData(null)).toBeNull();
			expect(calls).toHaveLength(0);
		});

		it("returns null on a non-OK response", async () => {
			mockQuota({ error: "unauthorized" }, 401);
			expect(await fetchQoderUsageData("jt-abc")).toBeNull();
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
