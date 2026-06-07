import { describe, expect, it } from "bun:test";
import type { RequestPayload, RequestSummary } from "../../api";
import { reconcileRequestsCache } from "../request-cache-reconcile";

function summary(id: string, timestampMs: number): RequestSummary {
	return {
		id,
		timestamp: new Date(timestampMs).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acc-1",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 50,
		failoverAttempts: 0,
		model: "test-model",
		totalTokens: 10,
	};
}

function placeholder(
	id: string,
	meta: Partial<RequestPayload["meta"]> = {},
): RequestPayload {
	return {
		id,
		request: { headers: {}, body: null },
		response: { status: 200, headers: {}, body: null },
		meta: {
			timestamp: Date.now(),
			path: "/v1/messages",
			method: "POST",
			bodiesOmitted: true,
			...meta,
		},
	};
}

describe("reconcileRequestsCache", () => {
	it("returns fetched rows when there is no previous cache", () => {
		const fetched = {
			requests: [placeholder("a")],
			detailsMap: new Map([["a", summary("a", 1000)]]),
		};

		const result = reconcileRequestsCache(fetched, undefined, 200);
		expect(result.requests.map((r) => r.id)).toEqual(["a"]);
	});

	it("preserves live-only rows with pendingPersistence after reload", () => {
		const liveTs = Date.now() - 5_000;
		const fetched = {
			requests: [placeholder("persisted-1")],
			detailsMap: new Map([["persisted-1", summary("persisted-1", 1000)]]),
		};
		const previous = {
			requests: [
				placeholder("live-only", {
					pendingPersistence: true,
					timestamp: liveTs,
				}),
				placeholder("persisted-1"),
			],
			detailsMap: new Map([
				["live-only", summary("live-only", liveTs)],
				["persisted-1", summary("persisted-1", 1000)],
			]),
		};

		const result = reconcileRequestsCache(fetched, previous, 200, Date.now());
		expect(result.requests.map((r) => r.id)).toEqual([
			"live-only",
			"persisted-1",
		]);
	});

	it("does not duplicate rows when fetched includes a previously live row", () => {
		const fetched = {
			requests: [placeholder("now-persisted")],
			detailsMap: new Map([["now-persisted", summary("now-persisted", 1000)]]),
		};
		const previous = {
			requests: [placeholder("now-persisted", { pendingPersistence: true })],
			detailsMap: new Map([["now-persisted", summary("now-persisted", 1000)]]),
		};

		const result = reconcileRequestsCache(fetched, previous, 200);
		expect(result.requests.map((r) => r.id)).toEqual(["now-persisted"]);
		expect(result.requests[0]?.meta.pendingPersistence).toBeUndefined();
	});

	it("drops stale pendingPersistence rows older than the retention window", () => {
		const oldTs = Date.now() - 31 * 60 * 1000;
		const fetched = {
			requests: [placeholder("persisted-1")],
			detailsMap: new Map([["persisted-1", summary("persisted-1", 1000)]]),
		};
		const previous = {
			requests: [
				placeholder("stale-live", {
					pendingPersistence: true,
					timestamp: oldTs,
				}),
			],
			detailsMap: new Map([["stale-live", summary("stale-live", oldTs)]]),
		};

		const result = reconcileRequestsCache(fetched, previous, 200);
		expect(result.requests.map((r) => r.id)).toEqual(["persisted-1"]);
	});

	it("preserves in-flight pending rows not yet summarized", () => {
		const fetched = {
			requests: [],
			detailsMap: new Map<string, RequestSummary>(),
		};
		const previous = {
			requests: [
				placeholder("in-flight", { pending: true, timestamp: Date.now() }),
			],
			detailsMap: new Map<string, RequestSummary>(),
		};

		const result = reconcileRequestsCache(fetched, previous, 200);
		expect(result.requests.map((r) => r.id)).toEqual(["in-flight"]);
	});
});
