# Session Cost Breakdown Display

**Date:** 2026-04-14
**Status:** Approved

## Summary

Display plan and API cost (USD) for the current session window on each account card in the web UI, broken down as separate values next to the existing token counts.

## Scope

Three focused changes — no new endpoints, no new DB round-trips, no schema migrations.

## 1. Database Layer — `getSessionStats`

**File:** `packages/database/src/repositories/stats.repository.ts`

Extend the existing SQL aggregate to sum `cost_usd` split by `billing_type`, using the same pattern already used in analytics:

```sql
SUM(CASE WHEN billing_type = 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as plan_cost_usd,
SUM(CASE WHEN billing_type != 'plan' OR billing_type IS NULL THEN COALESCE(cost_usd, 0) ELSE 0 END) as api_cost_usd
```

The `WHERE` clause (session window filter) is unchanged. The query result row type gains two numeric fields. The returned `Map<string, SessionStats>` values include the new cost fields.

## 2. Types — `SessionStats`

**File:** `packages/types/src/account.ts`

Add two fields to `SessionStats`:

```ts
planCostUsd: number;
apiCostUsd: number;
```

Both are always numeric (default 0). No optional/nullable — the DB query always returns a value via `COALESCE`.

## 3. UI — `AccountListItem`

**File:** `packages/dashboard-web/src/components/accounts/AccountListItem.tsx`

Append cost values to the existing session stats line when non-zero:

```
Session: 3 req · ↑ 12.3k in · ✦ 4.5k cache↑ · ✦ 1.2k cache↓ · ↓ 8.9k out · $1.20 plan · $0.03 api
```

Rules:
- Format: `$X.XX` (2 decimal places, `toFixed(2)`)
- Each segment only rendered when its value `> 0`
- No cost shown at all if both are zero — no regression for providers that don't track cost

## Error Handling

No new error paths. The existing `.catch(() => new Map())` in the accounts handler already swallows `getSessionStats` failures gracefully.

## Testing

Existing `getSessionStats` tests in `stats.repository.ts` should be extended with a fixture that includes requests with `billing_type = 'plan'` and `billing_type = 'api'` to verify the cost aggregation.
