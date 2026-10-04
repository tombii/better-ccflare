import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import type { APIContext } from "../../types";
import { createAnalyticsHandler } from "../analytics";

describe("analytics totals on a seeded database", () => {
	let dbOps: DatabaseOperations;

	beforeEach(async () => {
		dbOps = new DatabaseOperations(
			join(tmpdir(), `test-analytics-${randomBytes(6).toString("hex")}.db`),
		);
		const adapter = dbOps.getAdapter();
		const ts = Date.now() - 60_000;
		const rows: Array<
			[
				string,
				string | null,
				number,
				number,
				number,
				number,
				string,
				number | null,
				number,
				number,
				number,
				number,
			]
		> = [
			// id, account, success, rt, total_tokens, cost, billing, tps, in, cr, cc, out
			["r1", "acct-a", 1, 100, 30, 0.5, "plan", 10, 10, 5, 5, 10],
			["r2", "acct-b", 1, 200, 60, 1.5, "api", 20, 20, 10, 10, 20],
			["r3", null, 0, 300, 0, 0.25, "api", null, 0, 0, 0, 0],
		];
		for (const r of rows) {
			await adapter.run(
				`INSERT INTO requests (id, timestamp, method, path, account_used, success, response_time_ms,
					total_tokens, cost_usd, billing_type, output_tokens_per_second,
					input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens)
				 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					r[0],
					ts,
					r[1],
					r[2],
					r[3],
					r[4],
					r[5],
					r[6],
					r[7],
					r[8],
					r[9],
					r[10],
					r[11],
				],
			);
		}
	});

	afterEach(() => {
		dbOps.dispose?.();
	});

	it("returns the expected totals and token breakdown", async () => {
		const handler = createAnalyticsHandler({
			db: {} as APIContext["db"],
			config: {} as APIContext["config"],
			dbOps,
		} as APIContext);
		const res = await handler(new URLSearchParams({ range: "24h" }));
		const body = (await res.json()) as {
			totals: Record<string, number | null>;
			tokenBreakdown: Record<string, number>;
		};

		expect(body.totals.requests).toBe(3);
		expect(body.totals.successRate).toBeCloseTo(200 / 3, 6);
		expect(body.totals.activeAccounts).toBe(3);
		expect(body.totals.avgResponseTime).toBe(200);
		expect(body.totals.totalTokens).toBe(90);
		expect(body.totals.totalCostUsd).toBeCloseTo(2.25, 9);
		expect(body.totals.planCostUsd).toBeCloseTo(0.5, 9);
		expect(body.totals.apiCostUsd).toBeCloseTo(1.75, 9);
		expect(body.totals.avgTokensPerSecond).toBe(15);
		expect(body.tokenBreakdown.inputTokens).toBe(30);
		expect(body.tokenBreakdown.cacheReadInputTokens).toBe(15);
		expect(body.tokenBreakdown.cacheCreationInputTokens).toBe(15);
		expect(body.tokenBreakdown.outputTokens).toBe(30);
	});
});
