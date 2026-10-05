/**
 * Router wiring: the /api/stats TTL cache must be cleared whenever
 * DatabaseOperations reports that request history was deleted, so every
 * in-process cleanupOldRequests() caller (scheduled retention, maintenance
 * endpoint) is covered, not just the HTTP cleanup route. The CLI runs in a
 * separate process and is not covered.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

describe("APIRouter /api/stats cache invalidation", () => {
	let router: APIRouter;
	let aggregateCalls: number;
	let listeners: Array<() => void>;

	beforeEach(() => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		aggregateCalls = 0;
		listeners = [];
		const dbOps = {
			getAdapter: () => adapter,
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
			onRequestsDeleted: (l: () => void) => {
				listeners.push(l);
				return () => {};
			},
			getStatsRepository: () => ({
				getAggregatedStats: async () => {
					aggregateCalls++;
					return {
						totalRequests: 0,
						successfulRequests: 0,
						avgResponseTime: 0,
						totalTokens: 0,
						totalCostUsd: 0,
						avgTokensPerSecond: null,
					};
				},
				getActiveAccountCount: async () => 0,
				getAccountStats: async () => [],
				getRecentErrorGroups: async () => [],
				getTopModels: async () => [],
				getSessionStats: async () => new Map(),
			}),
		} as unknown as DatabaseOperations;
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const context = {
			db: adapter,
			config,
			dbOps,
			alertService: {},
		} as unknown as APIContext;
		router = new APIRouter(context);
	});

	const get = async () => {
		const url = new URL("http://localhost/api/stats");
		return router.handleRequest(url, new Request(url));
	};

	it("serves from cache until the request-deleted signal fires", async () => {
		await get();
		await get();
		expect(aggregateCalls).toBe(1);
		expect(listeners.length).toBe(1);
		for (const l of listeners) l();
		await get();
		expect(aggregateCalls).toBe(2);
	});
});
