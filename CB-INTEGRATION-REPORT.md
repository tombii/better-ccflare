# CB-INTEGRATION-REPORT — feat/circuit-breaker

## Summary

Built `feat/circuit-breaker` as a coherent single-branch integration of the
seven circuit-breaker inputs, off `upstream/main` HEAD `053746c1`.

The spec called out three traps. All three were hit and handled:

1. **`merge-tree` lies about add/add.** I confirmed this empirically:
   `git merge-tree` against upstream/main reported CLEAN, but a real
   octopus merge of `916c473b 61825651 a3a9bf38 983437cb b47ba72e 3803084c`
   failed with:
   ```
   Added packages/proxy/src/__tests__/stream-admission.test.ts in both, but differently.
   ERROR: content conflict in packages/proxy/src/__tests__/stream-admission.test.ts
   Added packages/proxy/src/stream-admission.ts in both, but differently.
   ERROR: content conflict in packages/proxy/src/stream-admission.ts
   ```
   The conflict is exactly the one the spec warned about: `b47ba72e` (sse-drain)
   and `3803084c` (capacity-endpoint) both independently cherry-picked the
   stream-admission module from `61825651` and modified it.
   
   **Resolution:** cherry-pick `61825651` first (introduces base stream-admission),
   then cherry-pick `b47ba72e` (sse-drain — adds breaker integration to it),
   then cherry-pick `3803084c` (capacity-endpoint — git auto-merges because
   `stream-admission.ts` and its test only appear once on the branch, and
   the version in place already has the breaker integration). No conflicts.

2. **F1.a is on the wrong tree.** `fix/cb-exhaustiveness-guard@24550bed`
   imports `@ccflare/*` and does NOT descend from upstream/main. Ported
   by hand; no merge attempted; zero `@ccflare/*` imports in the final
   branch.

3. **V2 imports must not leak.** Verified below — zero `@ccflare/`
   occurrences in `packages/` or `apps/`.

## Environment

- Worktree: `/tmp/claude-501/cb-integration-check` (sandbox-allowed; the
  standard `/Users/vvladescu/.ao/data/worktrees/ccflare/` siblings were
  blocked by the sandbox's write allowlist).
- `bun install` ran fresh in the worktree's own `node_modules` (NOT a
  symlink to another worktree). Required because `packages/providers`
  declares `google-auth-library`.
- `bun run build:cli` and `bun run build:dashboard` ran to generate
  the inline worker modules and embedded dashboard assets before the
  `apps/server` and capacity-state tests would run.

## Commit history (feat/circuit-breaker)

```
b61cf4f9 fix(proxy): update stream-admission test to upstream RateLimitReason literal
11c27531 fix(proxy): enforce RateLimitReason exhaustiveness in circuit breaker (F1.a, ported)
27e17e49 feat(http-api): add GET /api/capacity-state endpoint
ecf3f19e feat(proxy): drain stream-admission waiters on circuit_open
68866886 feat(proxy): add circuit_open reason to pool-exhausted response
89cb0aef fix(proxy): wire circuit breaker into cooldown chokepoint and active-clear
65b2bf9a feat(proxy): per-account SSE stream admission control
840d6494 fix(proxy): align circuit breaker to upstream vocabulary and bound cooldown
86e87324 feat(proxy): circuit breaker core state machine
053746c1 fix: repair broken tests and eliminate cross-file mock.module pollution [skip-version]   <-- upstream/main
```

Module(s) → wiring → endpoint ordering preserved. Squash boundaries
match logical integration steps. The sse-drain's docs commit
(`e4ee9131`) was dropped as it only modified `REPORT-task-b.md`.

## Acceptance results (each ran independently)

| # | Command | Result |
|---|---------|--------|
| 1a | `bunx tsc --noEmit -p packages/proxy/tsconfig.json` | EXIT=0 |
| 1b | `bunx tsc --noEmit -p packages/types/tsconfig.json` | EXIT=0 |
| 1c | `bunx tsc --noEmit -p packages/http-api/tsconfig.json` | EXIT=0 |
| 1d | `bunx tsc --noEmit -p apps/server/tsconfig.json` | EXIT=0 |
| 2 | `bun test packages/proxy/src/__tests__/circuit-breaker.test.ts` | 40 pass / 0 fail (105 expect) |
| 3 | `bun test packages/proxy/src/__tests__/stream-admission.test.ts` | 17 pass / 0 fail (84 expect) |
| 4 | `bun test packages/proxy/src/__tests__/circuit-open-response.test.ts` | 8 pass / 0 fail (29 expect) |
| 5 | `bun test packages/proxy/src/__tests__/rate-limit-cooldown-circuit-breaker.test.ts` | 4 pass / 0 fail (11 expect) |
| 6 | `bun test packages/http-api/src/__tests__/capacity-state.test.ts` | 4 pass / 0 fail (17 expect) |
| 7a | `git merge-tree <merge-base> HEAD upstream/main` | CLEAN (0 output lines) |
| 7b | trial merge (octopus of 6 cherry-pick candidates) | **CONFLICT** (confirms spec warning) |
| 7c | trial merge (`git merge feat/circuit-breaker` from upstream/main HEAD) | **CLEAN** |

## F1.a port — substance and verification

The F1.a commit on `origin/main` (24550bed) adds an `assertNever` guard
to `shouldCountAsCircuitFailure` and a `RATE_LIMIT_REASONS` const array
in `packages/types/src/rate-limit-reason.ts`. It also pins the
"every variant" parity test in `circuit-breaker.test.ts` to that array
and adds a `_coverage` type-level assertion.

The port to upstream's layout differs in two respects:

1. **Source of truth for the type** — upstream already defines
   `RateLimitReason` as a union literal in `packages/types/src/account.ts`.
   The port imports the type from there into
   `packages/types/src/rate-limit-reason.ts` (rather than re-defining it),
   and the `RATE_LIMIT_REASONS` const array is typed as
   `readonly RateLimitReason[]` — divergence between the two is a
   TypeScript error.
2. **Namespace** — V2 imports `@ccflare/*`; upstream uses
   `@better-ccflare/*`. Port stays on `@better-ccflare/*`.

**TS2345 verification** (spec §"Verify the port with the same test the
orchestrator used"):

Temporarily added the literal
`"TEST_NEW_VARIANT_FOR_EXHAUSTIVENESS_CHECK"` to the `RateLimitReason`
union in `packages/types/src/account.ts`. `bunx tsc --noEmit -p
packages/proxy/tsconfig.json` then emitted:

```
packages/proxy/src/circuit-breaker.ts(226,23): error TS2345: Argument of type '"TEST_NEW_VARIANT_FOR_EXHAUSTIVENESS_CHECK"' is not assignable to parameter of type 'never'.
```

Captured verbatim above. The line 226:23 is the
`default: return assertNever(kind)` call site. Variant was removed
afterwards; tsc passes again (EXIT=0); git status clean.

The runtime test suite stayed green in both states (the runtime
parity test exercises the union variants that ARE in the array, so it
is invariant to the temporary variant). This matches the spec's
warning that a runtime-only check is insufficient.

## Mandatory proof-of-work block

```
$ git merge-base --is-ancestor upstream/main HEAD && echo OK
OK

$ git log --oneline upstream/main..HEAD
b61cf4f9 fix(proxy): update stream-admission test to upstream RateLimitReason literal
11c27531 fix(proxy): enforce RateLimitReason exhaustiveness in circuit breaker (F1.a, ported)
27e17e49 feat(http-api): add GET /api/capacity-state endpoint
ecf3f19e feat(proxy): drain stream-admission waiters on circuit_open
68866886 feat(proxy): add circuit_open reason to pool-exhausted response
89cb0aef fix(proxy): wire circuit breaker into cooldown chokepoint and active-clear
65b2bf9a feat(proxy): per-account SSE stream admission control
840d6494 fix(proxy): align circuit breaker to upstream vocabulary and bound cooldown
86e87324 feat(proxy): circuit breaker core state machine

$ git diff --stat upstream/main HEAD
 apps/server/src/server.ts                          |  28 +-
 packages/database/src/database-operations.ts       |  11 +-
 .../src/repositories/account.repository.ts         |  40 +-
 .../http-api/src/__tests__/capacity-state.test.ts  | 196 ++++++
 packages/http-api/src/handlers/capacity-state.ts   |  59 ++
 packages/http-api/src/router.ts                    |  16 +
 packages/http-api/src/services/auth-service.ts     |   9 +
 .../proxy/src/__tests__/circuit-breaker.test.ts    | 638 ++++++++++++++++++
 .../src/__tests__/circuit-open-response.test.ts    | 228 +++++++
 .../rate-limit-cooldown-circuit-breaker.test.ts    | 216 ++++++
 .../proxy/src/__tests__/stream-admission.test.ts   | 747 +++++++++++++++++++++
 packages/proxy/src/circuit-breaker.ts              | 575 ++++++++++++++++
 packages/proxy/src/handlers/index.ts               |   2 +
 packages/proxy/src/handlers/proxy-operations.ts    | 128 +++-
 packages/proxy/src/handlers/rate-limit-cooldown.ts |  20 +
 packages/proxy/src/index.ts                        |  23 +
 packages/proxy/src/stream-admission.ts             | 461 +++++++++++++
 packages/types/src/context.ts                      |  16 +
 packages/types/src/index.ts                        |   1 +
 packages/types/src/rate-limit-reason.ts            |  56 ++
 20 files changed, 3430 insertions(+), 40 deletions(-)

$ git grep -c "@ccflare/" -- packages apps
(no output — 0 matches across the tree)

$ # TS2345 verbatim (from the verification capture):
packages/proxy/src/circuit-breaker.ts(226,23): error TS2345: Argument of type '"TEST_NEW_VARIANT_FOR_EXHAUSTIVENESS_CHECK"' is not assignable to parameter of type 'never'.

$ git rev-parse HEAD upstream/main
b61cf4f9... (feat/circuit-breaker)
053746c1... (upstream/main)   <-- DIFFERENT — tree is NOT byte-identical to base
```

The previous-worker's failure mode (commit byte-identical to base) is
not present here: HEAD's tree differs from upstream/main by 20 files,
3430 insertions, 40 deletions.

## Rules compliance

- Did NOT push.
- Did NOT open a PR.
- Did NOT touch any live service (`ccmax.zp.digital`, etc.).
- Did NOT change the load-balancing strategy.
- Did NOT merge `24550bed` (V2 tree); ported by hand.
- Did NOT symlink another worktree's `node_modules`; ran `bun install`
  fresh.
- Did NOT silently fix unrelated issues; the stream-admission test
  vocabulary alignment is reported as a separate commit because it is
  a direct consequence of the F1.a port (not "unrelated cleanup").
