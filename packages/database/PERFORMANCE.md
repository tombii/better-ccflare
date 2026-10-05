# Database Performance Optimizations

## Overview

This document describes the database indexes added to improve query performance in the Claude proxy load balancer.

## Indexes

### `requests` table (7 indexes)

`requests` is the hottest table, and every index on it is rewritten on each
INSERT, usage UPDATE and retention DELETE, so the set is kept minimal. SQLite has 7 indexes on `requests`; PostgreSQL has 6 (no `idx_requests_client_session`).

| Index | Definition | Serves |
|-------|------------|--------|
| `idx_requests_account_timestamp` | `(account_used, timestamp DESC)` | Per-account lookups, session stats |
| `idx_requests_model_timestamp` | `(model, timestamp DESC)` WHERE `model IS NOT NULL` | Model analytics, top models |
| `idx_requests_api_key_timestamp` | `(api_key_id, timestamp DESC)` WHERE `api_key_id IS NOT NULL` | API key analytics |
| `idx_requests_analytics_covering` | `(timestamp, success, total_tokens, cost_usd, billing_type, ...)` | Index-only analytics and stats aggregates |
| `idx_requests_summary_covering` | `(timestamp DESC, id, account_used, status_code, ...)` | Timestamp-ordered scans, retention DELETE batches, alert sums |
| `idx_requests_err_ts_cov` | SQLite: `(timestamp DESC, account_used, error_message)`; PostgreSQL: `(timestamp DESC, account_used)`; both WHERE `error_message IS NOT NULL` | Grouped error list (`getRecentErrorGroups`). PostgreSQL omits `error_message` from the key because btree entries (and `INCLUDE` columns) are capped at ~2.7KB and an oversized message would make writes fail |
| `idx_requests_client_session` | SQLite only: `(client_session_id, timestamp DESC)` WHERE `client_session_id IS NOT NULL` | Session-to-account lookup. Deliberately not created on PostgreSQL: `client_session_id` is client-controlled, uncapped TEXT (from the request body's `metadata.user_id`) and a value over ~2.7KB would make inserts into `requests` fail as a btree key. On PostgreSQL the lookup stays an unindexed scan. A future fix needs a cap at ingestion, or an index on `left(client_session_id, N)` plus a matching query |

Twelve older indexes were dropped (redundant prefixes of the above, or partial
indexes whose predicate no query emits): `idx_requests_timestamp`,
`idx_requests_account_used`, `idx_requests_timestamp_account`,
`idx_requests_success_timestamp`, `idx_requests_cost_model`,
`idx_requests_response_time`, `idx_requests_tokens`, `idx_requests_api_key`,
`idx_requests_project_timestamp`, `idx_requests_cleanup`,
`idx_requests_billing_type_timestamp`, and `idx_requests_account` (never created by the app; it came from the old deployment docs). They are removed by `DROP INDEX IF
EXISTS` in `migrations.ts` (SQLite) and `migrations-pg.ts` (PostgreSQL); the
list lives in `REDUNDANT_REQUEST_INDEXES` in `src/performance-indexes.ts`.
Never re-add a CREATE for them or they will be dropped again on every start.

### Other tables
- `idx_accounts_paused` on `accounts(paused)` WHERE `paused = 0`: active account lookups
- `idx_accounts_name` on `accounts(name)`: joins by account name
- `idx_accounts_rate_limited` on `accounts(rate_limited_until)`: rate limit checks
- `idx_accounts_session` on `accounts(session_start, session_request_count)`: session strategy
- `idx_accounts_request_count` on `accounts(request_count DESC, last_used)`: load balancer ordering

## Query Optimizations

### P95 Response Time Calculation
The p95 response time calculation has been optimized to use SQL window functions instead of loading all response times into memory:

```sql
WITH ordered_times AS (
  SELECT 
    response_time_ms,
    ROW_NUMBER() OVER (ORDER BY response_time_ms) as row_num,
    COUNT(*) OVER () as total_count
  FROM requests
  WHERE model = ? AND response_time_ms IS NOT NULL
)
SELECT response_time_ms as p95_response_time
FROM ordered_times
WHERE row_num = CAST(CEIL(total_count * 0.95) AS INTEGER)
LIMIT 1
```

## Performance Analysis

To analyze the performance impact of these indexes:

```bash
# From the database package directory
bun run analyze

# Or from the project root
cd packages/database && bun run analyze
```

This will show:
- Current index usage statistics
- Query execution plans
- Performance timings for common queries

## Maintenance Considerations

1. **Index Size**: The indexes add storage overhead but significantly improve query performance
2. **Write Performance**: Every index on `requests` adds work to each INSERT/UPDATE/DELETE; add new ones only with a measured query that needs them
3. **Statistics**: Run `ANALYZE` periodically to keep query optimizer statistics current
4. **Monitoring**: Use the analyze script to verify indexes are being used effectively

## Future Optimizations

Consider these additional optimizations if needed:
1. Composite indexes for complex WHERE clauses
2. Covering indexes to avoid table lookups
3. Partial indexes for frequently filtered subsets
4. Query rewriting for better index utilization