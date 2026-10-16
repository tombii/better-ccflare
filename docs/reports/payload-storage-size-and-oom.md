# Payload storage size and memory pressure

**Status:** Compression shipped in PR #490 (`feat/payload-compression`). The
`temp_store` change was implemented, then reverted — see §6.

**Date:** 2026-10-16
**Host:** `llm.tombii.com` (live container `better-ccflare`, `ghcr.io/tombii/better-ccflare:latest`)
**Trigger:** a 2.5GB database, plus repeated OOM kills of the container.

---

## 1. Question

Three linked questions came out of a 2.5GB database and repeated OOM kills:

1. Would moving to PostgreSQL shrink the database?
2. Can SQLite tables be compressed?
3. Is `temp_store = MEMORY` causing the OOM kills?

## 2. What the 2.5GB actually is

Measured on the live container DB (`/data/better-ccflare.db`, 2.53GB):

| Object | Size | Share |
|---|---|---|
| `request_payloads` | 2,324 MB | 92% |
| `idx_usage_snapshots_acct_win_time` | 30 MB | 1% |
| `usage_snapshots` | 16 MB | <1% |
| `requests` (all metadata/analytics) | 12 MB | <1% |
| every index on `requests` | ~20 MB | <1% |

`request_payloads` holds 4,901 rows averaging **484KB** each (max 3MB; the write
cap is 4MB via `MAX_REQUEST_BODY_BYTES`). Payloads are large because they carry
full conversation history.

So the question is entirely about one table of large JSON blobs. The
metadata/analytics side is trivially small.

## 3. Retention is working — the size is expected

An early hypothesis was that cleanup was not pruning. It is:

- Config (`/data/better-ccflare/better-ccflare.json`): `data_retention_days: 3`,
  `request_retention_days: 45`, `store_payloads: true`.
- Log: `Periodic cleanup: removed 0 requests, 10 payloads in 54ms`.
- Payload timestamps span exactly Oct 13 → Oct 16 (3 days).

Growth is **~750–915 MB/day** of payloads across ~1,600 requests/day. The 2.5GB
is 3 days of legitimately-retained data, not a leak. Nothing was misconfigured.

## 4. Postgres vs application-level compression

| Option | Effect | Cost |
|---|---|---|
| Postgres | TOAST auto-compresses values over ~2KB (pglz/LZ4), out-of-line | A server process, connections, backups — for one table |
| App-level zstd on the `json` column | Same or better shrink, backend-agnostic | Small code change, no new dependency |
| Lower `data_retention_days` | Linear | Loses payload history |

Postgres would work, but it buys nothing here that application-level
compression does not, and the payload code path is already dialect-neutral (all
access goes through `RequestRepository` → `BaseRepository` → `BunSqlAdapter`,
which is the single dialect branch point).

## 5. SQLite cannot compress tables — in memory or on disk

- No `COMPRESS` DDL or table clause exists.
- The page cache holds **uncompressed** 4KB pages.
- `mmap_size` maps the on-disk format, which is uncompressed.
- ZIPVFS is a licensed *file-format* extension, not an in-memory feature.

The only route to compressed payloads is application-level. Note that a read
still materialises the **decompressed** JSON (it must be parsed), so compression
reduces stored bytes — not the peak of a single read, and not the memory held by
payloads queued for writing (see §7).

## 6. `temp_store = MEMORY` — implemented, then reverted

The main connection hard-coded `PRAGMA temp_store = MEMORY`
(`database-operations.ts`), while both vacuum workers force `temp_store = FILE`
with the comment *"never spill temp tables to RAM under cgroup pressure"*. That
asymmetry looked like a real RSS-spike path: analytics queries in
`stats.repository.ts` issue many `GROUP BY` / `ORDER BY`, and N concurrent
queries each build their own temp b-trees with no ceiling — the only uncapped
temp allocation path.

A fix was implemented and committed (`tempStore?: "MEMORY" | "FILE"`, default
`FILE`, threaded through `RuntimeConfig` / `db_temp_store` / the factory, plus
docs), then **reverted** because the evidence did not support it:

- The analytics queries only touch the `requests` table, which is **12 MB**.
  With `cache_size = -20000` (20MB) most sorts never spill at all, so the
  expected spill is single-digit MB/day — not a 3GB OOM.
- Container memory sat at 245MB / 3GB with `OOMKilled=false`; the live
  contributors could not be shown to be temp b-trees.

Reverting was the right call: an unproven change to a hot query path is not
worth carrying. The commit is recoverable from the reflog if measurement later
implicates it. (A tmpfs mount at `/tmp` would get bounded-to-a-size RAM for
temp tables without the heap-growth risk, if it ever becomes relevant — note the
container's `/tmp` is on overlayfs, i.e. host disk, not tmpfs.)

## 7. The more likely OOM driver: duplicated payload copies

Reading the capture path in `packages/proxy/src/usage-collector.ts` shows the
payload body is duplicated several times per in-flight request:

```
state.startMessage.requestBody     ← base64 string, retained for the request's life
        ↓
requestBody = startMessage.requestBody          (same reference)
        ↓
JSON.stringify({ request: { body: requestBody },
                 response: { body: responseBody } })   ← NEW string, bodies inlined
        ↓
payloadJson ──► queued in the async writer (still UNCOMPRESSED)
                    │  the job closure captures payload.json
                    ▼
             compress → encrypt → stored bytes   (runs when the writer drains it)
```

Bodies are stored **base64** (~33% larger than raw; see the `Buffer.byteLength(
requestBody, "base64")` handling), then again inside the stringified
`payloadJson`, plus transient byte copies during encode/compress/encrypt.

The three 100MB budgets (`MAX_ACTIVE_PAYLOAD_BYTES`, `MAX_PENDING_PAYLOAD_BYTES`,
`PAYLOAD_BYTES_CAP`) each count only part of this. Critically,
`activePayloadBytes` tracks only the retained request body's byte length — it
does **not** count the `payloadJson` copy, so 100MB of budgeted payload can be
roughly 2× that in real heap, and momentarily more during serialization. A burst
of concurrent large requests is exactly the shape that reaches an OOM.

**This is from reading the code, not a measured heap profile.** It fits the
observed correlation (kills during concurrent long requests) better than the
`temp_store` theory, but confirming it needs a measurement: next time RSS
climbs, capture `docker stats better-ccflare` — if RSS tracks concurrent large
requests, this is it; if it drifts while idle, the driver is elsewhere
(e.g. JSC heap growth).

**Compression does NOT reduce this path's memory.** The async writer's job
closure captures `payload.json` uncompressed, and compression only runs later —
inside `saveRequestPayloadRaw` → `encodePayloadForStorage`, when the writer
actually drains the job (see `enqueuePreparedPayload` in `usage-collector.ts`).
So the queued payload stays a full-size uncompressed string, and
`PAYLOAD_BYTES_CAP` / `payload.bytes` count uncompressed bytes. Compression
shrinks the *stored* bytes and the transient allocations *inside* the write
callback (the encryption step sees the smaller compressed body instead of the
raw JSON), but it does not shrink queued or retained payload memory.

That means the three 100MB budgets are untouched by this change, and the
duplication above still bounds how much concurrent large requests can hold.

## 8. Write volume and flash wear

For anyone running this on NVMe, the compression change reduces writes rather
than increasing them:

| Write source | Volume/day |
|---|---|
| Payload rows | **~850 MB** |
| Request metadata | ~12 MB (table total) |
| WAL autocheckpoint | 4MB threshold (`wal_autocheckpoint=1000`) |
| `temp_store=FILE` spill (had it shipped) | ~0–10 MB |

Compression at 3.3× cuts payload writes to **~258 MB/day**, a saving of
**~590 MB/day ≈ 215 GB/year**. The temp-spill figure was at most ~2% of that,
so the flash-wear objection does not favour `MEMORY` here. Even without
compression, ~0.31 TB/year is well inside typical consumer NVMe ratings
(300–600 TBW).

## 9. Measured compression ratio

Measured on real payloads from the DB, not synthetic data: **3.3×**
(553KB → 165KB). An earlier 5–10× estimate was too optimistic — real
conversation history is less repetitive than synthetic samples. Realistic
outcome on the live DB: **~2.3GB → ~700MB**.

Existing rows are not rewritten; the shrink happens as rows age out under
`data_retention_days` (3 days here), with incremental vacuum reclaiming pages.
There is no immediate file-size drop.

## 10. The second reader (Greptile P1 on PR #490)

Greptile found a P1 the initial change missed: `request_payloads.json` has
readers **outside** `request.repository.ts`, and one of them parsed the raw
column.

- **Broken:** `getCachedOrPersistedCodexUsage` in
  `packages/http-api/src/handlers/accounts.ts` did `JSON.parse(row.json)` on the
  raw column. With no encryption key set, compressed rows are `zst:…` and fail
  to parse, so Codex usage recovery silently fell back to the weekly snapshot
  after a restart or cache expiry.
- **Safe:** `insights.ts` joins `request_payloads` only to test row *existence*
  (`COUNT` / `JOIN`), never parsing `json`.
- **Safe:** `analyzePayloadJson` (raw-string parser in `context-insights.ts`) has
  no production callers — production uses `analyzePayloadWrapper` with
  `getRequestPayload`, which already decodes.

Fixed by routing the reader through `dbOps.getRequestPayload` (the same idiom
`insights.ts` uses), which decodes compression and at-rest encryption. The
`RequestRepository` is now exported from `@better-ccflare/database` so callers
that genuinely need stored payloads have a sanctioned decoder instead of parsing
raw bytes.

The regression test stores a payload through the repository (so it is genuinely
`zst:`-marked) and was verified to **fail** against the pre-fix handler.

## 11. Outcome

- **PR #490** — application-level zstd compression of the `json` column
  (`zst:` + base64, compress-then-encrypt, no migration, works with or without
  `PAYLOAD_ENCRYPTION_KEY`, never inflates a payload), plus the Codex reader fix
  and the additional `savePayloadRaw` / `listPayloadsWithAccountNames` coverage.
- **Reverted** — the `temp_store` change (§6).
- **Open** — the payload-accounting question (§7) needs a measurement before any
  change; do not guess at `MAX_ACTIVE_PAYLOAD_BYTES` without one.
