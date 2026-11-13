import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type {
	ApiKeyResponse,
	ApiKeyUsageResponse,
} from "@better-ccflare/types";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../../lib/query-keys";
import {
	applyApiKeySpendReset,
	resetSpendConfirmation,
} from "../../api-keys/reset-spend";

describe("reset spend dashboard state", () => {
	it("documents one production replica and the reset sync interval for other replicas", () => {
		const docs = readFileSync(
			new URL("../../../../../../docs/configuration.md", import.meta.url),
			"utf8",
		);
		expect(docs).toContain("Production runs one replica.");
		expect(docs).toContain(
			"Other replicas observe a spend reset on their next synchronization (at most 2 minutes)",
		);
	});
	it("names the key and explains what the confirmation preserves", () => {
		expect(resetSpendConfirmation("team / app")).toBe(
			"Reset the spend of team / app against its limits to zero? Its limits stay; usage history is kept. In-flight reservations are cleared; their actual cost counts when recorded after this reset.",
		);
	});

	it("refreshes every cached gauge immediately without changing historical usage", () => {
		const client = new QueryClient();
		const updated = {
			id: "key",
			name: "team / app",
			spendResetAt: 123,
			spendResetBy: "admin",
			limits: [{ id: "limit", spentUsd: 0, resetsAt: "2026-11-14T00:00:00Z" }],
		} as ApiKeyResponse;
		const original = {
			apiKey: { id: "key", name: "team / app" },
			limits: [{ id: "limit", spentUsd: 6 }],
			limit: { spentUsd: 6 },
			requests: 8,
			totalCostUsd: 6,
			series: [{ ts: 0, apiCostUsd: 6 }],
		} as ApiKeyUsageResponse;
		const other = { ...original, apiKey: { ...original.apiKey, id: "other" } };
		client.setQueryData(queryKeys.apiKeys(), [
			{ ...updated, limits: original.limits },
			{ id: "other" },
		]);
		for (const range of ["24h", "7d"])
			client.setQueryData(queryKeys.apiKeyUsage("team / app", range), original);
		client.setQueryData(queryKeys.apiKeyUsage("other", "24h"), other);
		try {
			applyApiKeySpendReset(client, updated);
			for (const range of ["24h", "7d"]) {
				const cached = client.getQueryData<ApiKeyUsageResponse>(
					queryKeys.apiKeyUsage("team / app", range),
				);
				expect(cached?.limits).toEqual(updated.limits);
				expect(cached?.apiKey.spendResetAt).toBe(123);
				expect(cached?.apiKey.spendResetBy).toBe("admin");
				expect(cached?.requests).toBe(8);
				expect(cached?.totalCostUsd).toBe(6);
				expect(cached?.series).toEqual(original.series);
			}
			expect(
				client.getQueryData(queryKeys.apiKeyUsage("other", "24h")),
			).toEqual(other);
			expect(
				client.getQueryData<ApiKeyResponse[]>(queryKeys.apiKeys())?.[0],
			).toEqual(updated);
		} finally {
			client.clear();
		}
	});
});
