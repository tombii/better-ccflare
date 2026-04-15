import { describe, it, expect } from "bun:test";
import "@better-ccflare/core";
import { StatsRepository } from "../stats.repository";

const createRepoWithRows = (rows: Array<Record<string, unknown>>) => {
  const adapter = {
    query: async () => rows,
  };

  return new StatsRepository(adapter as any);
};

describe("getSessionStats cost aggregation", () => {
  it("should include planCostUsd and apiCostUsd in returned stats", async () => {
    const repo = createRepoWithRows([
      {
        account_used: "acc-1",
        requests: 3,
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 100,
        output_tokens: 500,
        plan_cost_usd: 1.23,
        api_cost_usd: 0.05,
      },
    ]);

    const result = await repo.getSessionStats([{ id: "acc-1", session_start: 1000 }]);
    const stats = result.get("acc-1");

    expect(stats).toBeDefined();
    expect(stats?.planCostUsd).toBe(1.23);
    expect(stats?.apiCostUsd).toBe(0.05);
  });

  it("should default cost to 0 when plan and api costs are null", async () => {
    const repo = createRepoWithRows([
      {
        account_used: "acc-2",
        requests: 1,
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 50,
        plan_cost_usd: null,
        api_cost_usd: null,
      },
    ]);

    const result = await repo.getSessionStats([{ id: "acc-2", session_start: 5000 }]);
    const stats = result.get("acc-2");

    expect(stats).toBeDefined();
    expect(stats?.planCostUsd).toBe(0);
    expect(stats?.apiCostUsd).toBe(0);
  });

  it("should return an empty map when accounts have no session start", async () => {
    const repo = new StatsRepository({
      query: async () => {
        throw new Error("query should not run when no sessions are active");
      },
    } as any);

    const result = await repo.getSessionStats([
      { id: "acc-3", session_start: null },
      { id: "acc-4", session_start: null },
    ]);

    expect(result.size).toBe(0);
  });
});
