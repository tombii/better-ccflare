import { describe, expect, it } from "bun:test";
import type { ComboFlowRecentRequest, RequestSummary } from "../../../api";
import {
	COMBO_FLOW_RECENT_LIMIT,
	mergeRecentRequests,
} from "../mergeRecentRequests";

const T0 = Date.parse("2026-11-09T10:00:00.000Z");

function serverRow(
	id: string,
	over: Partial<ComboFlowRecentRequest> = {},
): ComboFlowRecentRequest {
	return {
		id,
		timestamp: T0,
		originalModel: "claude-sonnet-4-5",
		appliedModel: null,
		servedModel: "glm-4.5",
		account: "alpha",
		statusCode: 200,
		success: true,
		failoverAttempts: 0,
		responseTimeMs: 100,
		...over,
	};
}

function liveRow(
	id: string,
	over: Partial<RequestSummary> = {},
): RequestSummary {
	return {
		id,
		timestamp: new Date(T0 + 1000).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "beta",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 200,
		failoverAttempts: 1,
		comboName: "Main",
		originalModel: "claude-sonnet-4-5",
		appliedModel: undefined,
		model: "glm-4.5",
		...over,
	} as RequestSummary;
}

describe("mergeRecentRequests", () => {
	it("keeps only rows tagged with the given combo", () => {
		const merged = mergeRecentRequests(
			[serverRow("s1")],
			[liveRow("l1"), liveRow("l2", { comboName: "Other" })],
			"Main",
		);
		expect(merged.map((r) => r.id)).toEqual(["l1", "s1"]);
	});

	it("dedupes by id with the live row winning", () => {
		const merged = mergeRecentRequests(
			[serverRow("same", { account: "stale-account", success: false })],
			[liveRow("same", { accountUsed: "fresh-account", success: true })],
			"Main",
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({
			id: "same",
			account: "fresh-account",
			success: true,
			failoverAttempts: 1,
		});
	});

	it("resolves a live row's account ID to a name via the map", () => {
		// The SSE summary carries accountUsed as the account ID; the server
		// rows carry display names. Without resolution the merge overwrites a
		// name with an opaque ID.
		const merged = mergeRecentRequests(
			[serverRow("s1", { account: "nano" })],
			[liveRow("l1", { accountUsed: "acc-nano" })],
			"Main",
			undefined,
			new Map([["acc-nano", "nano"]]),
		);
		expect(merged[0].account).toBe("nano");
	});

	it("falls back to the raw id when the account is unknown", () => {
		const merged = mergeRecentRequests(
			[],
			[liveRow("l1", { accountUsed: "acc-gone" })],
			"Main",
			undefined,
			new Map([["acc-other", "someone"]]),
		);
		expect(merged[0].account).toBe("acc-gone");
	});

	it("orders newest first across both sources", () => {
		const merged = mergeRecentRequests(
			[
				serverRow("a", { timestamp: T0 }),
				serverRow("c", { timestamp: T0 + 2000 }),
			],
			[liveRow("b", { timestamp: new Date(T0 + 1000).toISOString() })],
			"Main",
		);
		expect(merged.map((r) => r.id)).toEqual(["c", "b", "a"]);
	});

	it("caps the merged list at the limit", () => {
		const server = Array.from({ length: 20 }, (_, i) =>
			serverRow(`s${i}`, { timestamp: T0 - i }),
		);
		const live = Array.from({ length: 5 }, (_, i) =>
			liveRow(`l${i}`, { timestamp: new Date(T0 + i + 1).toISOString() }),
		);
		const merged = mergeRecentRequests(server, live, "Main");
		expect(merged).toHaveLength(COMBO_FLOW_RECENT_LIMIT);
		// Live rows are the newest, so they all survive the cap.
		expect(merged.slice(0, 5).map((r) => r.id)).toEqual([
			"l4",
			"l3",
			"l2",
			"l1",
			"l0",
		]);
	});
});
