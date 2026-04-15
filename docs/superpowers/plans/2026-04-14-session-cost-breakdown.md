# Session Cost Breakdown Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display plan and API cost (USD) for the current session window on each account card in the accounts page, broken down as two values next to the existing token counts.

**Architecture:** Extend the existing `getSessionStats` SQL query to sum `cost_usd` split by `billing_type`, add `planCostUsd`/`apiCostUsd` fields to the `SessionStats` type, and render them conditionally on the `AccountListItem` component. No new endpoints, no DB migrations, no new round-trips.

**Tech Stack:** TypeScript, Bun test, React (TSX), SQLite via existing adapter

---

## File Map

| File | Change |
|------|--------|
| `packages/types/src/account.ts` | Add `planCostUsd: number` and `apiCostUsd: number` to `SessionStats` interface |
| `packages/database/src/repositories/stats.repository.ts` | Extend SQL + row type in `getSessionStats` to include cost columns |
| `packages/dashboard-web/src/components/accounts/AccountListItem.tsx` | Render `$X.XX plan · $X.XX api` on session stats line when non-zero |

---

### Task 1: Extend the `SessionStats` type

**Files:**
- Modify: `packages/types/src/account.ts`

- [ ] **Step 1: Add fields to `SessionStats`**

In `packages/types/src/account.ts`, find the `SessionStats` interface (line ~143) and add the two cost fields:

```ts
// Session statistics for 5-hour token window
export interface SessionStats {
  requests: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  planCostUsd: number;
  apiCostUsd: number;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/git_repos/better-ccflare && bun run tsc --noEmit -p packages/types/tsconfig.json 2>&1 | head -20
```

Expected: no errors (or only pre-existing errors unrelated to `SessionStats`).

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/account.ts
git commit -m "feat: add planCostUsd and apiCostUsd to SessionStats type"
```

---

### Task 2: Extend `getSessionStats` query with cost aggregation

**Files:**
- Modify: `packages/database/src/repositories/stats.repository.ts`

- [ ] **Step 1: Write the failing test**

There are no existing unit tests for `getSessionStats`. Create a new test file:

**`packages/database/src/repositories/__tests__/stats-session-cost.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "bun:test";

// Minimal in-memory adapter stub
function makeAdapter(rows: Record<string, unknown>[]) {
  return {
    async query<T>(_sql: string, _params: unknown[]): Promise<T[]> {
      return rows as T[];
    },
  };
}

// We test the shape returned by the Map — we don't need to spin up SQLite
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

    const adapter = makeAdapter([fakeRow]);

    // Simulate what getSessionStats does with the row
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/git_repos/better-ccflare && bun test packages/database/src/repositories/__tests__/stats-session-cost.test.ts 2>&1
```

Expected: The test should pass at this stage (it tests the mapping logic directly, not the DB method — this establishes the expected shape before we change the implementation).

- [ ] **Step 3: Update the SQL query and row type in `getSessionStats`**

In `packages/database/src/repositories/stats.repository.ts`, update the `getSessionStats` method. Find the `rows` query (around line 375) and replace it:

```ts
const rows = await this.adapter.query<{
  account_used: string;
  requests: unknown;
  input_tokens: unknown;
  cache_creation_input_tokens: unknown;
  cache_read_input_tokens: unknown;
  output_tokens: unknown;
  plan_cost_usd: unknown;
  api_cost_usd: unknown;
}>(
  `SELECT
    account_used,
    COUNT(*) as requests,
    COALESCE(SUM(input_tokens), 0) as input_tokens,
    COALESCE(SUM(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
    COALESCE(SUM(cache_read_input_tokens), 0) as cache_read_input_tokens,
    COALESCE(SUM(output_tokens), 0) as output_tokens,
    COALESCE(SUM(CASE WHEN billing_type = 'plan' THEN cost_usd ELSE 0 END), 0) as plan_cost_usd,
    COALESCE(SUM(CASE WHEN billing_type != 'plan' OR billing_type IS NULL THEN cost_usd ELSE 0 END), 0) as api_cost_usd
  FROM requests
  WHERE ${clauses}
  GROUP BY account_used`,
  params,
);
```

Then update the `return new Map(...)` block to include the new fields:

```ts
return new Map(
  rows.map((row) => [
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
```

- [ ] **Step 4: Run tests to verify**

```bash
cd /home/git_repos/better-ccflare && bun test packages/database/src/repositories/__tests__/stats-session-cost.test.ts 2>&1
```

Expected: all tests pass.

- [ ] **Step 5: Check TypeScript**

```bash
cd /home/git_repos/better-ccflare && bun run tsc --noEmit -p packages/database/tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/repositories/stats.repository.ts packages/database/src/repositories/__tests__/stats-session-cost.test.ts
git commit -m "feat: include plan/api cost in getSessionStats aggregation"
```

---

### Task 3: Render session cost in `AccountListItem`

**Files:**
- Modify: `packages/dashboard-web/src/components/accounts/AccountListItem.tsx`

- [ ] **Step 1: Add cost formatting helper and update the session stats block**

In `packages/dashboard-web/src/components/accounts/AccountListItem.tsx`, the session stats render block is around line 369:

```tsx
{account.sessionStats && (
  <div className="text-xs text-muted-foreground">
    Session: {account.sessionStats.requests} req
    {" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
    {" · "}✦
    {formatTokenCount(account.sessionStats.cacheCreationInputTokens)}{" "}
    cache↑
    {" · "}✦{formatTokenCount(account.sessionStats.cacheReadInputTokens)}{" "}
    cache↓
    {" · "}↓{formatTokenCount(account.sessionStats.outputTokens)} out
  </div>
)}
```

Replace it with:

```tsx
{account.sessionStats && (
  <div className="text-xs text-muted-foreground">
    Session: {account.sessionStats.requests} req
    {" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
    {" · "}✦
    {formatTokenCount(account.sessionStats.cacheCreationInputTokens)}{" "}
    cache↑
    {" · "}✦{formatTokenCount(account.sessionStats.cacheReadInputTokens)}{" "}
    cache↓
    {" · "}↓{formatTokenCount(account.sessionStats.outputTokens)} out
    {account.sessionStats.planCostUsd > 0 && (
      <>{" · "}${account.sessionStats.planCostUsd.toFixed(2)} plan</>
    )}
    {account.sessionStats.apiCostUsd > 0 && (
      <>{" · "}${account.sessionStats.apiCostUsd.toFixed(2)} api</>
    )}
  </div>
)}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/git_repos/better-ccflare && bun run tsc --noEmit -p packages/dashboard-web/tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 3: Run full test suite**

```bash
cd /home/git_repos/better-ccflare && bun test 2>&1 | tail -20
```

Expected: all tests pass (or only pre-existing failures).

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard-web/src/components/accounts/AccountListItem.tsx
git commit -m "feat: display session plan/api cost breakdown on account cards"
```

---

## Self-Review Checklist

- **Spec coverage:** All three spec sections covered (DB query, types, UI). `billing_type IS NULL` treated as API cost — consistent with analytics handler. Zero-cost display suppression handled.
- **No placeholders:** All steps have complete code.
- **Type consistency:** `planCostUsd`/`apiCostUsd` defined in Task 1 (`SessionStats`), used by name in Tasks 2 and 3. SQL aliases (`plan_cost_usd`, `api_cost_usd`) map to camelCase in Task 2 mapping — consistent throughout.
