import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readUsageUtilization } from "@better-ccflare/core";
import {
	fetchOpencodeGoUsageData,
	getRepresentativeOpencodeGoUtilization,
	getRepresentativeOpencodeGoWindow,
	OPENCODE_GO_USAGE_ENDPOINT,
} from "../opencode-go-usage-fetcher";

/**
 * Documented shape of `GET https://opencode.ai/zen/go/v1/usage`.
 * rolling = 5-hour window, weekly = weekly window, monthly = billing period.
 * Go's limits are a shared pool: 5h = 20% of monthly, weekly = 50%, monthly 100%.
 */
const SAMPLE_BODY = {
	usage: {
		rolling: {
			status: "ok",
			percent: 3,
			resetsAt: "2026-11-14T15:03:46.000Z",
		},
		weekly: {
			status: "ok",
			percent: 19,
			resetsAt: "2026-11-16T00:00:00.000Z",
		},
		monthly: {
			status: "ok",
			percent: 74,
			resetsAt: "2026-11-15T04:29:48.000Z",
		},
	},
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("OpenCode Go usage fetcher", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("requests the documented endpoint with the API key as a bearer token", async () => {
		const fetchMock = mock(async () => jsonResponse(SAMPLE_BODY));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await fetchOpencodeGoUsageData("oc-key");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
		expect(url).toBe(OPENCODE_GO_USAGE_ENDPOINT);
		expect(init.method).toBe("GET");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer oc-key");
		expect(headers.Accept).toBe("application/json");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("normalises percent into utilization and passes ISO resets through", async () => {
		globalThis.fetch = (async () =>
			jsonResponse(SAMPLE_BODY)) as unknown as typeof fetch;

		const usage = await fetchOpencodeGoUsageData("k");

		expect(usage).toEqual({
			five_hour: { utilization: 3, resets_at: "2026-11-14T15:03:46.000Z" },
			seven_day: { utilization: 19, resets_at: "2026-11-16T00:00:00.000Z" },
			monthly: { utilization: 74, resets_at: "2026-11-15T04:29:48.000Z" },
		});
	});

	it("converts an epoch-ms resetsAt into an ISO string", async () => {
		const epochMs = Date.UTC(2026, 10, 14, 15, 3, 46);
		globalThis.fetch = (async () =>
			jsonResponse({
				usage: {
					rolling: { status: "ok", percent: 5, resetsAt: epochMs },
					weekly: { status: "ok", percent: 10, resetsAt: null },
					monthly: { status: "ok", percent: 20, resetsAt: epochMs },
				},
			})) as unknown as typeof fetch;

		const usage = await fetchOpencodeGoUsageData("k");

		expect(usage?.five_hour).toEqual({
			utilization: 5,
			resets_at: "2026-11-14T15:03:46.000Z",
		});
		expect(usage?.seven_day).toEqual({ utilization: 10, resets_at: null });
	});

	it("does not crash on unknown status values and skips unparsable windows", async () => {
		globalThis.fetch = (async () =>
			jsonResponse({
				usage: {
					rolling: { status: "limited", percent: 100, resetsAt: "x" },
					weekly: { status: "ok", percent: "nope", resetsAt: "y" },
					monthly: "garbage",
				},
			})) as unknown as typeof fetch;

		const usage = await fetchOpencodeGoUsageData("k");

		// An unparsable resetsAt becomes null; the percent is still kept.
		expect(usage?.five_hour).toEqual({ utilization: 100, resets_at: null });
		expect(usage?.seven_day).toBeNull();
		expect(usage?.monthly).toBeNull();
	});

	it("clamps a percent above 100 to 100", async () => {
		globalThis.fetch = (async () =>
			jsonResponse({
				usage: { rolling: { status: "ok", percent: 140, resetsAt: null } },
			})) as unknown as typeof fetch;

		const usage = await fetchOpencodeGoUsageData("k");

		expect(usage?.five_hour?.utilization).toBe(100);
	});

	it("clamps a negative percent to 0", async () => {
		globalThis.fetch = (async () =>
			jsonResponse({
				usage: { rolling: { status: "ok", percent: -5, resetsAt: null } },
			})) as unknown as typeof fetch;

		const usage = await fetchOpencodeGoUsageData("k");

		expect(usage?.five_hour?.utilization).toBe(0);
	});

	it("preserves a fractional percent without rounding", async () => {
		globalThis.fetch = (async () =>
			jsonResponse({
				usage: { rolling: { status: "ok", percent: 12.3456, resetsAt: null } },
			})) as unknown as typeof fetch;

		const usage = await fetchOpencodeGoUsageData("k");

		expect(usage?.five_hour?.utilization).toBe(12.3456);
	});

	it("keeps 99.96 below 100 so a nearly-full window is not benched", async () => {
		// isUsageExhausted is `utilization >= 100`; rounding 99.96 up to 100
		// would mark an account with quota left as exhausted (false exhaustion).
		globalThis.fetch = (async () =>
			jsonResponse({
				usage: { rolling: { status: "ok", percent: 99.96, resetsAt: null } },
			})) as unknown as typeof fetch;

		const usage = await fetchOpencodeGoUsageData("k");

		expect(usage?.five_hour?.utilization).toBe(99.96);
	});

	it("returns null when no window parses", async () => {
		globalThis.fetch = (async () =>
			jsonResponse({
				usage: { rolling: {}, weekly: null, monthly: { percent: null } },
			})) as unknown as typeof fetch;

		expect(await fetchOpencodeGoUsageData("k")).toBeNull();
	});

	it("returns null when the body has no usage object", async () => {
		globalThis.fetch = (async () =>
			jsonResponse({ ok: true })) as unknown as typeof fetch;

		expect(await fetchOpencodeGoUsageData("k")).toBeNull();
	});

	it("returns null on a 401", async () => {
		globalThis.fetch = (async () =>
			jsonResponse(
				{
					type: "error",
					error: { type: "AuthError", message: "Unauthorized" },
				},
				401,
			)) as unknown as typeof fetch;

		expect(await fetchOpencodeGoUsageData("k")).toBeNull();
	});

	it("returns null on malformed JSON", async () => {
		globalThis.fetch = (async () =>
			new Response("not json{", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		expect(await fetchOpencodeGoUsageData("k")).toBeNull();
	});

	it("returns null on a network failure", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;

		expect(await fetchOpencodeGoUsageData("k")).toBeNull();
	});

	it("aborts a stalled request instead of hanging the poll slot", async () => {
		let sawAbort = false;
		globalThis.fetch = mock(
			async (_input: RequestInfo, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						sawAbort = true;
						reject(new DOMException("aborted", "AbortError"));
					});
				}),
		) as unknown as typeof fetch;

		const data = await fetchOpencodeGoUsageData("k");

		expect(sawAbort).toBe(true);
		expect(data).toBeNull();
	}, 15_000);
});

describe("OpenCode Go representative window", () => {
	it("picks the most exhausted window", async () => {
		const usage = {
			five_hour: { utilization: 3, resets_at: "2026-11-14T15:03:46.000Z" },
			seven_day: { utilization: 19, resets_at: "2026-11-16T00:00:00.000Z" },
			monthly: { utilization: 74, resets_at: "2026-11-15T04:29:48.000Z" },
		};

		expect(getRepresentativeOpencodeGoUtilization(usage)).toBe(74);
		expect(getRepresentativeOpencodeGoWindow(usage)).toBe("monthly");
	});

	it("on a tie prefers the window that resets later", () => {
		const usage = {
			five_hour: { utilization: 50, resets_at: "2026-11-14T15:03:46.000Z" },
			seven_day: { utilization: 50, resets_at: "2026-11-16T00:00:00.000Z" },
			monthly: { utilization: 50, resets_at: "2026-11-15T04:29:48.000Z" },
		};

		expect(getRepresentativeOpencodeGoUtilization(usage)).toBe(50);
		expect(getRepresentativeOpencodeGoWindow(usage)).toBe("seven_day");
	});

	it("ignores windows with null utilization", () => {
		const usage = {
			five_hour: { utilization: null, resets_at: "2026-11-16T00:00:00.000Z" },
			seven_day: { utilization: 12, resets_at: "2026-11-15T00:00:00.000Z" },
			monthly: null,
		};

		expect(getRepresentativeOpencodeGoUtilization(usage)).toBe(12);
		expect(getRepresentativeOpencodeGoWindow(usage)).toBe("seven_day");
	});

	it("returns null for an empty payload", () => {
		expect(getRepresentativeOpencodeGoUtilization(null)).toBeNull();
		expect(getRepresentativeOpencodeGoWindow(null)).toBeNull();
		expect(
			getRepresentativeOpencodeGoUtilization({
				five_hour: null,
				seven_day: null,
				monthly: null,
			}),
		).toBeNull();
	});
});

describe("readUsageUtilization for opencode-go", () => {
	it("reads the normalised five_hour/seven_day windows with no provider branch", () => {
		// The fetcher emits the flat `{ utilization, resets_at }` shape, which the
		// generic path already understands — this pins that no opencode-go
		// specific branch is needed in readUsageUtilization.
		const payload = {
			five_hour: { utilization: 3, resets_at: "2026-11-14T15:03:46.000Z" },
			seven_day: { utilization: 19, resets_at: "2026-11-16T00:00:00.000Z" },
			monthly: { utilization: 74, resets_at: "2026-11-15T04:29:48.000Z" },
		};

		expect(readUsageUtilization(payload, "opencode-go")).toEqual({
			fiveHour: 3,
			weekly: 19,
		});
	});
});
