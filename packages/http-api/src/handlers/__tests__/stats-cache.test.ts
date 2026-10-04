import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { createStatsHandler } from "../stats";

function makeDbOps() {
	const repo = {
		getAggregatedStats: mock(async () => ({
			totalRequests: 10,
			successfulRequests: 5,
			avgResponseTime: 12.4,
			totalTokens: 100,
			totalCostUsd: 1.5,
			avgTokensPerSecond: 3,
		})),
		getActiveAccountCount: mock(async () => 2),
		getAccountStats: mock(async () => []),
		getRecentErrorGroups: mock(async () => []),
		getTopModels: mock(async () => []),
	};
	const dbOps = {
		getStatsRepository: () => repo,
	} as unknown as DatabaseOperations;
	return { repo, dbOps };
}

const u = (q = "") => new URL(`http://localhost/api/stats${q}`);

describe("createStatsHandler caching", () => {
	it("serves sequential requests with the same params from cache", async () => {
		const { repo, dbOps } = makeDbOps();
		const handler = createStatsHandler(dbOps);
		const a = await (await handler(u("?since=7"))).json();
		const b = await (await handler(u("?since=7"))).json();
		expect(b).toEqual(a);
		expect(a.successRate).toBe(50);
		expect(a.avgResponseTime).toBe(12);
		expect(repo.getAggregatedStats).toHaveBeenCalledTimes(1);
		expect(repo.getTopModels).toHaveBeenCalledTimes(1);
	});

	it("keeps per-account counts and top models lifetime, not windowed by ?since", async () => {
		const { repo, dbOps } = makeDbOps();
		const handler = createStatsHandler(dbOps);
		await handler(u("?since=7"));
		expect(repo.getAccountStats).toHaveBeenCalledWith(10, true);
		expect(repo.getTopModels).toHaveBeenCalledWith();
	});

	it("dedups concurrent requests", async () => {
		const { repo, dbOps } = makeDbOps();
		const handler = createStatsHandler(dbOps);
		await Promise.all([handler(u()), handler(u()), handler(u())]);
		expect(repo.getAggregatedStats).toHaveBeenCalledTimes(1);
	});

	it("recomputes for different params", async () => {
		const { repo, dbOps } = makeDbOps();
		const handler = createStatsHandler(dbOps);
		await handler(u("?since=7"));
		await handler(u("?since=8"));
		await handler(u("?since=7&errorsSinceHours=48"));
		expect(repo.getAggregatedStats).toHaveBeenCalledTimes(3);
	});

	it("does not share cache between handler instances", async () => {
		const { repo, dbOps } = makeDbOps();
		await createStatsHandler(dbOps)(u());
		await createStatsHandler(dbOps)(u());
		expect(repo.getAggregatedStats).toHaveBeenCalledTimes(2);
	});
});
