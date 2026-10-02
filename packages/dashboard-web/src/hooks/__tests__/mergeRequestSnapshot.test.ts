import { describe, expect, it } from "bun:test";
import type { RequestPayload, RequestResponse } from "../../api";
import { mergeRequestSnapshot } from "../queries";

const row = (id: string, timestamp: number): RequestPayload => ({
	id,
	request: { headers: {}, body: null },
	response: null,
	meta: { timestamp },
});

const summary = (id: string) => ({ id }) as RequestResponse;

const state = (rows: [string, number][]) => ({
	requests: rows.map(([id, ts]) => row(id, ts)),
	detailsMap: new Map(rows.map(([id]) => [id, summary(id)])),
});

const ids = (s: { requests: RequestPayload[] }) => s.requests.map((r) => r.id);

describe("mergeRequestSnapshot", () => {
	it("carries over a live row newer than the snapshot", () => {
		const snapshot = state([
			["b", 200],
			["a", 100],
		]);
		const cached = state([
			["c", 300],
			["b", 200],
			["a", 100],
		]);
		const merged = mergeRequestSnapshot(snapshot, cached, 10);
		expect(ids(merged)).toEqual(["c", "b", "a"]);
		expect(merged.detailsMap.has("c")).toBe(true);
	});

	it("does not carry over older rows the server already pruned", () => {
		const snapshot = state([["b", 200]]);
		const cached = state([
			["b", 200],
			["a", 100],
		]);
		const merged = mergeRequestSnapshot(snapshot, cached, 10);
		expect(ids(merged)).toEqual(["b"]);
		expect(merged.detailsMap.has("a")).toBe(false);
	});

	it("dedupes by id, preferring the snapshot row", () => {
		const snapshot = state([["b", 200]]);
		const cached = state([
			["c", 300],
			["b", 250],
		]);
		const merged = mergeRequestSnapshot(snapshot, cached, 10);
		expect(ids(merged)).toEqual(["c", "b"]);
		expect(merged.requests[1].meta?.timestamp).toBe(200);
	});

	it("bounds the result to limit and prunes detailsMap", () => {
		const snapshot = state([
			["b", 200],
			["a", 100],
		]);
		const cached = state([
			["c", 300],
			["b", 200],
			["a", 100],
		]);
		const merged = mergeRequestSnapshot(snapshot, cached, 2);
		expect(ids(merged)).toEqual(["c", "b"]);
		expect([...merged.detailsMap.keys()].sort()).toEqual(["b", "c"]);
	});

	it("returns the snapshot when the cache is empty", () => {
		const snapshot = state([["a", 100]]);
		expect(mergeRequestSnapshot(snapshot, undefined, 10)).toBe(snapshot);
	});

	it("keeps live rows when the snapshot is empty", () => {
		const cached = state([["a", 100]]);
		const merged = mergeRequestSnapshot(state([]), cached, 10);
		expect(ids(merged)).toEqual(["a"]);
	});

	it("tolerates a cached detailsMap that is not a Map", () => {
		const snapshot = state([["a", 100]]);
		const cached = {
			requests: [row("b", 200)],
			detailsMap: [summary("b")],
		} as unknown as Parameters<typeof mergeRequestSnapshot>[1];
		const merged = mergeRequestSnapshot(snapshot, cached, 10);
		expect(ids(merged)).toEqual(["b", "a"]);
		expect(merged.detailsMap.has("b")).toBe(true);
	});
});
