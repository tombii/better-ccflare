# Session Window Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display per-account 5h session window request count + token breakdown (input, cache create, cache read, output) inline on each account card in the Accounts tab.

**Architecture:** Add a `getSessionStats()` batch method to `StatsRepository` that queries the `requests` table for the current session window per account. The accounts API handler calls it after fetching accounts and merges the results into `AccountResponse`. The frontend renders the stats inline in the session info line.

**Tech Stack:** TypeScript, SQLite (via BunSqlAdapter), React, TanStack Query

---

## File Map

| File | Change |
|------|--------|
| `packages/types/src/account.ts` | Add `sessionStats` field to `AccountResponse` |
| `packages/database/src/repositories/stats.repository.ts` | Add `getSessionStats()` method |
| `packages/http-api/src/handlers/accounts.ts` | Call `getSessionStats()` and merge into each response object |
| `packages/dashboard-web/src/components/accounts/AccountListItem.tsx` | Render inline token breakdown |

---

### Task 1: Add `sessionStats` to `AccountResponse` type

**Files:**
- Modify: `packages/types/src/account.ts`

- [ ] **Step 1: Add the `SessionStats` interface and `sessionStats` field to `AccountResponse`**

In `packages/types/src/account.ts`, add the new interface and field. Add the interface just before `AccountResponse`:

```typescript
export interface SessionStats {
  requests: number;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}
```

Then in the `AccountResponse` interface, add after `billingType`:

```typescript
  sessionStats: SessionStats | null;
```

- [ ] **Step 2: Add `sessionStats: null` to `toAccountResponse()` default**

In `packages/types/src/account.ts`, in the `toAccountResponse()` function's return object, add after `billingType`:

```typescript
    sessionStats: null,
```

- [ ] **Step 3: Run typecheck**

```bash
cd /home/git_repos/better-ccflare && bun run typecheck 2>&1 | head -40
```

Expected: errors only about `sessionStats` missing from places that build `AccountResponse` manually (the accounts handler) — we fix those in Task 3. No errors in `types` package itself.

- [ ] **Step 4: Commit**

```bash
cd /home/git_repos/better-ccflare
git add packages/types/src/account.ts
git commit -m "feat: add sessionStats field to AccountResponse type"
```

---

### Task 2: Add `getSessionStats()` to `StatsRepository`

**Files:**
- Modify: `packages/database/src/repositories/stats.repository.ts`

- [ ] **Step 1: Add the `SessionStats` import and method**

In `packages/database/src/repositories/stats.repository.ts`, add this import at the top (after the existing import):

```typescript
import type { SessionStats } from "@better-ccflare/types";
```

Then add the `getSessionStats()` method at the end of the `StatsRepository` class, before the closing `}`:

```typescript
  /**
   * Get aggregated token stats for each account's current session window.
   * Only accounts with a non-null session_start are included.
   * Returns a Map keyed by account ID.
   */
  async getSessionStats(
    accounts: Array<{ id: string; session_start: number | null }>,
  ): Promise<Map<string, SessionStats>> {
    const active = accounts.filter((a) => a.session_start !== null) as Array<{
      id: string;
      session_start: number;
    }>;

    if (active.length === 0) return new Map();

    // Build a WHERE clause: (account_used = ? AND timestamp >= ?) OR ...
    const clauses = active.map(() => "(account_used = ? AND timestamp >= ?)").join(" OR ");
    const params: (string | number)[] = active.flatMap((a) => [a.id, a.session_start]);

    const rows = await this.adapter.query<{
      account_used: string;
      requests: unknown;
      input_tokens: unknown;
      cache_creation_input_tokens: unknown;
      cache_read_input_tokens: unknown;
      output_tokens: unknown;
    }>(
      `SELECT
        account_used,
        COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0) as cache_read_input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM requests
      WHERE ${clauses}
      GROUP BY account_used`,
      params,
    );

    return new Map(
      rows.map((row) => [
        row.account_used,
        {
          requests: Number(row.requests) || 0,
          inputTokens: Number(row.input_tokens) || 0,
          cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
          cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
          outputTokens: Number(row.output_tokens) || 0,
        },
      ]),
    );
  }
```

- [ ] **Step 2: Run typecheck on the database package**

```bash
cd /home/git_repos/better-ccflare && bun run typecheck 2>&1 | grep "stats.repository" | head -20
```

Expected: no errors from `stats.repository.ts`.

- [ ] **Step 3: Commit**

```bash
cd /home/git_repos/better-ccflare
git add packages/database/src/repositories/stats.repository.ts
git commit -m "feat: add getSessionStats() to StatsRepository"
```

---

### Task 3: Wire `getSessionStats()` into the accounts API handler

**Files:**
- Modify: `packages/http-api/src/handlers/accounts.ts`

The accounts handler builds `AccountResponse[]` in a `Promise.all(accounts.map(...))` block (around line 252). We need to:
1. Call `getSessionStats()` once before the map
2. Look up each account's stats inside the map and add `sessionStats` to the returned object

- [ ] **Step 1: Call `getSessionStats()` before the response map**

`dbOps` is the `DatabaseOperations` instance passed to the handler. `DatabaseOperations` exposes `getStatsRepository()` which returns the `StatsRepository` singleton. No new import needed.

In the accounts handler, find the line:

```typescript
		const response: AccountResponse[] = await Promise.all(
			accounts.map(async (account) => {
```

Insert this block immediately before it:

```typescript
		// Fetch session-window token stats for all accounts that have an active session
		const sessionStatsMap = await dbOps
			.getStatsRepository()
			.getSessionStats(
				accounts.map((a) => ({
					id: a.id,
					session_start: a.session_start ? Number(a.session_start) : null,
				})),
			)
			.catch(() => new Map());

```

- [ ] **Step 3: Add `sessionStats` to the returned object inside the map**

Inside the `return { ... }` block (around line 431), add `sessionStats` after `billingType`:

```typescript
			billingType: account.billing_type,
			sessionStats: sessionStatsMap.get(account.id) ?? null,
```

- [ ] **Step 4: Run typecheck**

```bash
cd /home/git_repos/better-ccflare && bun run typecheck 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/git_repos/better-ccflare
git add packages/http-api/src/handlers/accounts.ts
git commit -m "feat: include session window token stats in accounts API response"
```

---

### Task 4: Render session stats inline in `AccountListItem`

**Files:**
- Modify: `packages/dashboard-web/src/components/accounts/AccountListItem.tsx`

- [ ] **Step 1: Add a `formatTokenCount` helper function**

At the top of `packages/dashboard-web/src/components/accounts/AccountListItem.tsx`, after the imports, add:

```typescript
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 2: Find the session info render location**

Search for where `presenter.sessionInfo` or `sessionInfo` is rendered in `AccountListItem.tsx`. It will be a JSX element like:

```tsx
<span ...>{presenter.sessionInfo}</span>
```

or similar. Read lines around it to get full context before making the change.

```bash
grep -n "sessionInfo\|session_info\|No active session" /home/git_repos/better-ccflare/packages/dashboard-web/src/components/accounts/AccountListItem.tsx
```

- [ ] **Step 3: Replace the session info render with the inline breakdown**

Replace the session info span (whatever it looks like from step 2) with:

```tsx
<span className="text-xs text-muted-foreground">
  {account.sessionStats ? (
    <>
      Session: {account.sessionStats.requests} req
      {" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
      {" · "}✦{formatTokenCount(account.sessionStats.cacheCreationInputTokens)} cache↑
      {" · "}✦{formatTokenCount(account.sessionStats.cacheReadInputTokens)} cache↓
      {" · "}↓{formatTokenCount(account.sessionStats.outputTokens)} out
    </>
  ) : (
    presenter.sessionInfo
  )}
</span>
```

Note: match the existing className/element type — the key change is the conditional content.

- [ ] **Step 4: Run typecheck**

```bash
cd /home/git_repos/better-ccflare && bun run typecheck 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 5: Run lint and format**

```bash
cd /home/git_repos/better-ccflare && bun run lint && bun run format
```

- [ ] **Step 6: Commit**

```bash
cd /home/git_repos/better-ccflare
git add packages/dashboard-web/src/components/accounts/AccountListItem.tsx
git commit -m "feat: display 5h session token breakdown inline on account cards"
```

---

### Task 5: Verify end-to-end

- [ ] **Step 1: Build the project**

```bash
cd /home/git_repos/better-ccflare && bun run build 2>&1 | tail -20
```

Expected: build completes without errors.

- [ ] **Step 2: Start the server on port 8081**

```bash
cd /home/git_repos/better-ccflare && bun start --serve --port 8081 &
sleep 15
```

- [ ] **Step 3: Check the accounts API response includes sessionStats**

```bash
curl -s http://localhost:8081/api/accounts | jq '.[0] | {name, sessionStats}'
```

Expected: each account object has a `sessionStats` field (either `null` for accounts with no active session, or an object with `requests`, `inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`).

- [ ] **Step 4: Open dashboard and verify UI**

Open `http://localhost:8081` in a browser, go to the Accounts tab, and verify:
- Accounts with an active session show the inline breakdown: `Session: N req · ↑X in · ✦Y cache↑ · ✦Z cache↓ · ↓W out`
- Accounts with no active session still show `No active session`

- [ ] **Step 5: Kill the test server**

```bash
kill %1 2>/dev/null || true
```
