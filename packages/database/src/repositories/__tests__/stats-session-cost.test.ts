import { describe, it, expect } from "bun:test";

describe("getSessionStats cost aggregation", () => {
  it("should include planCostUsd and apiCostUsd in returned stats", async () => {
    const fakeRow = {
      account_used: "acc-1",
      requests: 3,
      input_tokens: 1000,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
      output_tokens: 500,
      plan_cost_usd: 1.23,
      api_cost_usd: 0.05,
    };

    const result = new Map(
      [fakeRow].map((row) => [
        row.account_used,
        {
          requests: Number(row.requests) || 0,
          inputTokens: Number(row.input_tokens) || 0,
          cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
          cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
          outputTokens: Number(row.output_tokens) || 0,
          planCostUsd: Number(row.plan_cost_usd) || 0,
          apiCostUsd: Number(row.api_cost_usd) || 0,
        },
      ]),
    );

    const stats = result.get("acc-1")!;
    expect(stats.planCostUsd).toBe(1.23);
    expect(stats.apiCostUsd).toBe(0.05);
  });

  it("should default cost to 0 when cost_usd is null", async () => {
    const fakeRow = {
      account_used: "acc-2",
      requests: 1,
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 50,
      plan_cost_usd: null,
      api_cost_usd: null,
    };

    const result = new Map(
      [fakeRow].map((row) => [
        row.account_used,
        {
          requests: Number(row.requests) || 0,
          inputTokens: Number(row.input_tokens) || 0,
          cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
          cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
          outputTokens: Number(row.output_tokens) || 0,
          planCostUsd: Number(row.plan_cost_usd) || 0,
          apiCostUsd: Number(row.api_cost_usd) || 0,
        },
      ]),
    );

    const stats = result.get("acc-2")!;
    expect(stats.planCostUsd).toBe(0);
    expect(stats.apiCostUsd).toBe(0);
  });
});
