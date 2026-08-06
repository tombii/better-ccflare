# Phantom heartbeat in the multi-instance guard

**Status:** Fix shipped on branch `ao/ccflare-156/fix-greptile-phantom-heartbeat` (open PR to `tombii/better-ccflare`).

**Related upstream threads:**

- PR #376 — Multi-instance guard (merged on `tombii/better-ccflare#376`). The first Greptile finding on that PR was addressed in commit `700155c3` ("fix: clear own heartbeat before refusing in multi-instance guard"). This report addresses a **second** finding on the same PR thread, raised by Greptile after `700155c3` landed.
- Issue #383 — PostgreSQL `instance_heartbeats` integer-out-of-range crash loop (`tombii/better-ccflare#383`). Different root cause, but the orphan rows it leaves behind are exactly the failure mode described in this report.

---

## 1. The bug

### Falsification (read first, fix second)

The Greptile finding is on `packages/database/src/multi-instance-guard.ts:311` (refuse-path cleanup). Verbatim from upstream `main` before the fix:

```typescript
if (mode === "refuse") {
    // ... (comment about clearing own heartbeat before throwing) ...
    try {
        await clearHeartbeat(adapter);
    } catch (err) {
        // Best-effort cleanup; surface the original refusal even if
        // the cleanup itself failed.
        log.warn(
            `heartbeat cleanup during refuse failed: ${(err as Error).message}`,
        );
    }
    throw new MultiInstanceRefusedError(result.peers);
}
```

The bug is **real**. Two-part check:

1. **The catch swallows the cleanup failure.** It logs `warn` and returns. It does not retry, it does not re-throw, it does not schedule a follow-up cleanup.
2. **A subsequent restart sees the orphan as a live peer.** `THIS_INSTANCE_ID` is a fresh `randomUUID()` generated at module load. After a refused startup, the orphan row in `instance_heartbeats` carries the **previous** process's instance_id. The new process's `scanHeartbeats()` filter is `WHERE instance_id != THIS_INSTANCE_ID`, which excludes only the new process's own id — it does NOT exclude the previous process's id. The previous-process row is therefore a peer candidate. If `last_heartbeat` is still inside `HEARTBEAT_EXPIRY_MS = 30_000`, the new startup refuses again.

Result: a single transient `DELETE` failure turns into a 30-second refusal window during which the operator cannot restart.

### Why the prior fix was incomplete

Commit `700155c3` correctly addressed the **first** Greptile finding: without an explicit cleanup call before the throw, the row would persist for up to 30 s on every refuse-path startup, including when the cleanup succeeds. Adding the `try { await clearHeartbeat(adapter); } catch { ... }` block fixed that.

But the fix wrapped `clearHeartbeat` in a `try/catch` that only logs. That silently regressed against the **transient-failure** scenario this report covers. The Greptile follow-up correctly observed that the catch hides a class of failures (SQLite `SQLITE_BUSY`, brief PG connection blips) that a retry could resolve in-place, and that the row stays present after the refuse throw.

---

## 2. The chain with #383 (PostgreSQL integer-out-of-range)

Issue #383 describes a production crash loop:

1. `instance_heartbeats.started_at` and `last_heartbeat` are created as `INTEGER` (32-bit) in `migrations-pg.ts`.
2. The code writes `Date.now()` epoch **milliseconds** (~1.79e12), which overflows `INTEGER` (max ~2.15e9).
3. The first heartbeat upsert throws `PostgresError: integer out of range`.
4. The unhandled throw kills the process.
5. Docker restarts the process. Same crash. Crash loop.

The production workaround applied in #383 was:

```sql
ALTER TABLE instance_heartbeats
  ALTER COLUMN started_at TYPE bigint,
  ALTER COLUMN last_heartbeat TYPE bigint;
DELETE FROM instance_heartbeats;  -- clear rows left by crashed incarnations
```

Note the manual `DELETE FROM instance_heartbeats`. **That `DELETE` is exactly the orphan-removal step the multi-instance guard now attempts in its refuse-path cleanup.** The crash loop in #383 generates orphans because:

- Crash attempt 1 writes a partial row before failing (or leaves the row from a previous schema-valid attempt).
- Crash attempt 2 starts up, finds that row, treats it as a peer, refuses.
- Refuse cleanup fails (because... well, the **next** crash is going to be the integer overflow again, but even in a healthy retry scenario the cleanup path is what we are fixing here).
- Orphan accumulates.

The two issues form a real bug chain: **#383 leaves orphans; the guard's pre-fix cleanup logic cannot reliably remove them.** Either issue alone is recoverable; together they are a permanent startup block until manual SQL intervention.

Neither PR #376's thread nor issue #383 references the other. They should be fixed together — the upstream `instance_heartbeats` columns should be widened to `bigint`, AND the guard's refuse-path cleanup should be resilient to transient DELETE failures.

---

## 3. The fix

Branch `ao/ccflare-156/fix-greptile-phantom-heartbeat` (this worktree), based on `upstream/main` at `6f2c9d28`.

### Approach: retry with bounded backoff

Considered three options:

| Option | What it does | Why not |
|---|---|---|
| **A. Retry the DELETE** with bounded exponential backoff | Re-attempt `clearHeartbeat` 3× with delays 25/50/100 ms before giving up. | **Chosen.** Smallest change. Directly addresses the transient-failure class named in the finding. |
| B. Make `instance_id` persistent across restarts (so this process excludes its own previous row) | Persist the UUID in a side file or derive from hostname+pid+boot-time | Larger change. Adds a new persistence surface and a new startup dependency. The orphan still affects any *other* peer-scanning logic; only the new process's own row is fixed. |
| C. Expire orphan rows more aggressively (shorter expiry window) | Tighten `HEARTBEAT_EXPIRY_MS` | Lowers safety margin for legitimate peers (the original #351 design risk). Masks the bug rather than fixing it. |

Option A is the **smallest correct fix** because:

- The Greptile finding explicitly names "transient connection error" and "temporarily busy" — both retryable.
- It does not change the contract for legitimate peers.
- If the retry exhausts, the original refusal is still surfaced and the orphan expires naturally on the next `purgeStaleHeartbeats` sweep after `HEARTBEAT_EXPIRY_MS`. The operator pays at most one extra failed restart per persistent-failure incident.

### Diff (excerpt)

```diff
+ /**
+  * Retry `clearHeartbeat` on transient failures (SQLITE_BUSY, brief PG
+  * connection errors, etc). Without this, a transient DELETE failure in
+  * the refuse-path cleanup of runStartupGuard leaves the just-written
+  * heartbeat row in place. A fast restart then sees that orphan as a
+  * peer (the new process has a fresh THIS_INSTANCE_ID, so it does not
+  * exclude its own previous row) and refuses startup again for up to
+  * HEARTBEAT_EXPIRY_MS. See tombii/better-ccflare#376 review (Greptile
+  * "Failed cleanup leaves phantom heartbeat") and #383 for the
+  * production crash-loop path that creates the orphans.
+  *
+  * Budget: 3 attempts with exponential backoff (25ms, 50ms, 100ms).
+  * Total worst-case latency ~175ms. If all attempts fail the caller
+  * still surfaces the original refusal; the orphan row then expires
+  * naturally after HEARTBEAT_EXPIRY_MS.
+  */
+ export async function clearHeartbeatWithRetry(
+     adapter: BunSqlAdapter,
+     options: { maxAttempts?: number; baseDelayMs?: number } = {},
+ ): Promise<void> {
+     const maxAttempts = options.maxAttempts ?? 3;
+     const baseDelayMs = options.baseDelayMs ?? 25;
+     let lastErr: Error | undefined;
+     for (let attempt = 1; attempt <= maxAttempts; attempt++) {
+         try {
+             await clearHeartbeat(adapter);
+             return;
+         } catch (err) {
+             lastErr = err as Error;
+             if (attempt < maxAttempts) {
+                 const delay = baseDelayMs * 2 ** (attempt - 1);
+                 await new Promise<void>((resolve) => setTimeout(resolve, delay));
+             }
+         }
+     }
+     throw lastErr ?? new Error("clearHeartbeatWithRetry: no attempts made");
+ }
```

And in `runStartupGuard`'s refuse branch:

```diff
- try {
-     await clearHeartbeat(adapter);
- } catch (err) {
-     log.warn(
-         `heartbeat cleanup during refuse failed: ${(err as Error).message}`,
-     );
- }
+ try {
+     await clearHeartbeatWithRetry(adapter);
+ } catch (err) {
+     log.warn(
+         `heartbeat cleanup during refuse failed after retries: ${(err as Error).message}`,
+     );
+ }
```

The shutdown-path stopper in `startHeartbeatLoop` still uses `clearHeartbeat` directly. On shutdown the process is dying anyway; the row expires after `HEARTBEAT_EXPIRY_MS` via `purgeStaleHeartbeats` on the next startup, so retry there adds shutdown latency for minimal benefit.

### Regression test

`NEGATIVE 5: refuse-mode cleanup survives a transient DELETE failure` in `packages/database/src/__tests__/multi-instance-guard.test.ts`:

- Pre-populates a peer row.
- Wraps the SQLite `db.run` so that the first `DELETE FROM instance_heartbeats` call throws a `SQLITE_BUSY`-like error.
- Calls `runStartupGuard(adapter, { mode: "refuse" })`.
- Asserts:
  - The original `MultiInstanceRefusedError` is still surfaced.
  - `deleteAttempts >= 2` (proving the retry fired).
  - Only the peer row remains in `instance_heartbeats` — the orphan was cleared.

Without the fix this test fails at `expect(remaining.length).toBe(1)` because the orphan row stays. With the fix it passes.

Two further unit tests cover `clearHeartbeatWithRetry` directly: success on first attempt (no retry), success after two transient failures (retry budget consumed), and rethrow after all attempts fail (caller still sees the original error).

### Verification

```
$ TMPDIR=/tmp/claude bun test packages/database/src/__tests__/multi-instance-guard.test.ts
bun test v1.3.2 (b131639c)

 17 pass
 3 skip
 0 fail
 64 expect() calls
Ran 20 tests across 1 file. [626.00ms]
```

The 3 skip are the live-PostgreSQL negative controls gated on `DATABASE_URL`. The 5 pre-existing failures elsewhere in `packages/database` are about a missing `inline-incremental-vacuum-worker` module (auto-generated per the project's CLAUDE.md); they exist on unmodified `upstream/main` and are unrelated to this change.

---

## 4. Recommendations for the maintainer

1. **Merge this fix** — `clearHeartbeatWithRetry` is the missing piece the Greptile follow-up requested. Land it before shipping any release that exposes `BETTER_CCFLARE_MULTI_INSTANCE=refuse` by default.
2. **Address #383 together.** The crash loop in #383 leaves behind exactly the orphans this fix removes. With the guard hardened, the workaround SQL in #383 becomes:

   ```sql
   ALTER TABLE instance_heartbeats
     ALTER COLUMN started_at TYPE bigint,
     ALTER COLUMN last_heartbeat TYPE bigint;
   ```

   (the manual `DELETE FROM instance_heartbeats` is no longer required for recovery — `purgeStaleHeartbeats` clears the orphans on the next healthy startup, and the guard's refuse-path cleanup now survives transient DELETE failures).
3. **Backfill the schema migration.** Add an entry to `columnsToAdd` in `runMigrationsPg()` that runs `ALTER TABLE instance_heartbeats ALTER COLUMN started_at TYPE bigint, ALTER COLUMN last_heartbeat TYPE bigint` so existing PG deployments self-heal on upgrade.
4. **Document the chain.** When the merged PR description is finalized, link to #383 (and vice versa) so the next maintainer sees both halves of the issue.

---

## 5. Failure modes the fix does NOT cover

Be explicit so the maintainer is not surprised:

- **Persistent DELETE failure** (DB truly down, schema mismatch, disk full): retry exhausts; orphan persists for `HEARTBEAT_EXPIRY_MS`. Operator gets one extra failed restart; not a permanent block.
- **`THIS_INSTANCE_ID` UUID collision**: cryptographically negligible; would let the new process exclude the old orphan. Same blast radius as before — silent inconsistency between two genuinely concurrent instances.
- **Heartbeat upsert itself fails** (write before scan): the guard never reaches the refuse branch; a different code path surfaces the original error. Out of scope for this fix.

---

*Filed by zenprocess in support of tombii/better-ccflare. PR and Greptile follow-up will reference this report.*