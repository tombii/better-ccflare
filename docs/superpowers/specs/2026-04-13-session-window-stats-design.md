# Session Window Stats Design

**Date:** 2026-04-13  
**Topic:** Track and display requests + token breakdown per 5h session window per account

---

## Overview

Each Anthropic account operates on a 5-hour usage window. The `accounts` table already tracks `session_start` and `session_request_count` for the current window. The `requests` table already stores full token data per request (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).

This feature adds a per-account session stats query that aggregates token data for the current 5h window and surfaces it inline on each account card in the Accounts tab.

---

## Scope

- Per-account, per-5h-window stats (not global/aggregate)
- Displayed inline on each account card in the Accounts tab
- No new UI tabs, panels, or endpoints

---

## Data Flow

### Backend

1. **`StatsRepository.getSessionStats(accounts)`**  
   New method. Takes an array of `{ id, session_start }` objects. Runs a single batch query against `requests`:

   ```sql
   SELECT
     account_used,
     COUNT(*) as requests,
     SUM(input_tokens) as input_tokens,
     SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
     SUM(cache_read_input_tokens) as cache_read_input_tokens,
     SUM(output_tokens) as output_tokens
   FROM requests
   WHERE (account_used = ? AND timestamp >= ?)
      OR (account_used = ? AND timestamp >= ?)
      ...
   GROUP BY account_used
   ```

   Returns a `Map<accountId, SessionStats>`. Accounts with `session_start = null` are excluded from the query and get `null` stats.

2. **Accounts API handler** (existing `/api/accounts` endpoint)  
   After fetching accounts, calls `getSessionStats()` with all accounts that have a non-null `session_start`. Merges results into each `AccountResponse`.

### Types

New field added to `AccountResponse` in `packages/types/src/account.ts`:

```typescript
sessionStats: {
  requests: number
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
} | null
```

`null` when the account has no active session (`session_start` is null).

---

## UI

**File:** `packages/dashboard-web/src/components/accounts/AccountListItem.tsx`

The existing session info line renders `presenter.sessionInfo` (a string like `"Session: 12 requests"` or `"No active session"`).

When `account.sessionStats` is non-null, replace this with an inline breakdown:

```
Session: 12 req · ↑3.2k in · ✦1.1k cache↑ · ✦2.4k cache↓ · ↓1.8k out
```

Format: numbers use `k`/`M` suffix (e.g., `1200 → 1.2k`, `1,200,000 → 1.2M`). When `sessionStats` is null, fall back to the existing `presenter.sessionInfo` string unchanged.

---

## Error Handling

- If the `requests` table has no rows for an account in the current window, the query returns 0 for all token fields — displayed as `0`.
- If `session_start` is null (no active session), `sessionStats` is null and the existing "No active session" text is shown.
- The batch query is best-effort: if it fails, the accounts list still returns (with `sessionStats: null` for all accounts).

---

## Files to Change

| File | Change |
|------|--------|
| `packages/types/src/account.ts` | Add `sessionStats` field to `AccountResponse` |
| `packages/database/src/repositories/stats.repository.ts` | Add `getSessionStats()` method |
| `packages/http-api/src/handlers/accounts.ts` (or equivalent) | Call `getSessionStats()` and merge into response |
| `packages/dashboard-web/src/components/accounts/AccountListItem.tsx` | Render inline token breakdown when `sessionStats` is non-null |

---

## Out of Scope

- Global/aggregate 5h window stats across all accounts
- New API endpoints
- Schema migrations
- Historical window tracking (only current window)
