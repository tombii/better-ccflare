# Mid-stream keepalive cooldown gap — report

- **Issue:** greptile-apps comment on merged upstream `tombii/better-ccflare` PR #196.
- **Branch:** `ao/ccflare-158/keepalive-midstream-skip` (off `upstream/main` `6f2c9d28`).
- **Author:** AO worker `ao/ccflare-158`.
- **Date:** 2026-08-06.

## Falsification (pre-fix)

Located all 4 cooldowns that fire on a 429 / mid-stream rate-limit signal and
counted how many carry the keepalive exemption. Results on `upstream/main`
`6f2c9d28`:

| # | File | Site | Cooldown call | Has keepalive skip |
|---|------|------|---------------|--------------------|
| 1 | `packages/proxy/src/handlers/proxy-operations.ts:944` | pre-stream, out_of_credits 429 | `return null` after keepalive block | ✅ |
| 2 | `packages/proxy/src/handlers/proxy-operations.ts:1004` | pre-stream, no-fallback-model 429 | `return null` after keepalive block | ✅ |
| 3 | `packages/proxy/src/handlers/proxy-operations.ts:1230` | pre-stream, post-model-list 429 | gated `if (isKeepalive) { ... } else { applyRateLimitCooldown(...) }` | ✅ |
| 4 | `packages/proxy/src/handlers/response-processor.ts:341` | pre-stream, header-based 429 (`processProxyResponse`) | `if (isKeepalive) { ...skipping cooldown }` then `else if/else` | ✅ |
| 5 | `packages/proxy/src/response-handler.ts:~286` | **mid-stream SSE rate-limit frame** | unconditional `applyRateLimitCooldown(...)` | ❌ |

3 of 4 sites pre-stream already skip the cooldown on synthetic keepalive
replays. The mid-stream SSE path (the 4th) does not. The gap is real.

## Why the gap matters

The cache-keepalive scheduler fires parallel requests to every cached
account simultaneously. A burst of 4+ concurrent requests can trip
Anthropic's per-IP burst limit and 429 every account at the same instant —
even though no real user-visible quota was hit on any individual account.
Treating those as real per-account rate limits drains the pool to zero
routable accounts.

Until the fix, a keepalive replay whose upstream returned 200 OK but later
emitted a mid-stream `event: error\ndata: {type: "error", error: {type:
"rate_limit_error"|"overloaded_error"}}` SSE frame would still write
`rate_limited_until` and cool the account, defeating the keepalive
scheduler's design.

## Fix shape

Applied the keepalive exemption to the mid-stream SSE path in
`packages/proxy/src/response-handler.ts`, matching the existing idiom from
the other 3 sites:

```ts
const isKeepalive = isInternalProbe(requestHeaders, ctx, "keepalive");
if (isKeepalive) {
    log.warn(
        `Keepalive replay for ${account.name} hit mid-stream rate-limit — ` +
        `skipping cooldown (synthetic burst, not a real per-account rate limit)`,
    );
} else if (rateLimitSniffer.firedReason === "overloaded_error") {
    applyRateLimitCooldown(account, { reason: "upstream_529_overloaded_no_reset" }, ctx);
} else {
    applyRateLimitCooldown(
        account,
        { resetTime: Date.now() + getMidStreamRateLimitCooldownMs(), reason: "upstream_429_with_reset" },
        ctx,
    );
}
```

Why the existing helper rather than a new one: `isInternalProbe` is already
imported in this file (used at line 171 for `isAutoRefreshProbe`), already
returns false for external clients forging the marker (the
`x-better-ccflare-internal-probe-secret` must match
`ctx.internalProbeSecret`), and is the same call the 3 other sites use.

## Regression tests (in `packages/proxy/src/handlers/__tests__/response-handler-midstream.test.ts`)

Added a `describe("forwardToClient — mid-stream keepalive exemption")` block
with 3 tests:

1. **`overloaded_error` mid-stream on a keepalive replay — `applyRateLimitCooldown`
   is NOT called.** Drives the real `forwardToClient` flow with keepalive
   headers + matching secret + a stream that emits an `overloaded_error`
   SSE frame. Asserts the spy is not called.

2. **`rate_limit_error` mid-stream on a keepalive replay — `applyRateLimitCooldown`
   is NOT called.** Same shape, different `firedReason`.

3. **Keepalive header WITHOUT the matching internal-probe secret —
   `applyRateLimitCooldown` IS called.** Pins the anti-forgery gate. An
   external client forging the marker alone cannot suppress cooldowns.

### Verification

Tests FAIL on unfixed `upstream/main` (`6f2c9d28`) code, PASS with the fix:

```
$ bun test packages/proxy/src/handlers/__tests__/response-handler-midstream.test.ts
# On upstream/main (no fix):
 8 pass, 2 fail
   FAIL: overloaded_error mid-stream on a keepalive replay: applyRateLimitCooldown is NOT called
     Expected number of calls: 0
     Received number of calls: 1
   FAIL: rate_limit_error mid-stream on a keepalive replay: applyRateLimitCooldown is NOT called
     Expected number of calls: 0
     Received number of calls: 1

# With fix:
$ bun test packages/proxy/src/handlers/__tests__/response-handler-midstream.test.ts
 10 pass, 0 fail
   7 pre-existing + 3 new
```

## Files changed

```
packages/proxy/src/response-handler.ts                                     | 43 +/-
packages/proxy/src/handlers/__tests__/response-handler-midstream.test.ts  | 199 +
docs/reports/keepalive-cooldown-gap.md                                     | new
```

## Broader test run

`bun test packages/proxy/src/...` reports `823 pass / 26 fail / 849 tests`
before AND after the fix. The 26 failures are pre-existing (port-binding in
`request-handler-client-abort.test.ts`, UsageCollector / issue #354 / Agent
Interceptor suites) and unrelated — confirmed by running the same suite
against both the pre-fix and post-fix trees and seeing identical failure
sets.

## Disposition: SECONDARY hygiene finding (CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS consolidation)

The pattern

```ts
Number(process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) ||
    TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS
```

appears in 3 places:

- `packages/proxy/src/handlers/proxy-operations.ts` (`extractCooldownUntil`)
- `packages/proxy/src/handlers/response-processor.ts` (`processProxyResponse` — proxied via `extractCooldownUntil`)
- `packages/proxy/src/response-handler.ts` (`getMidStreamRateLimitCooldownMs`)

**Folded out of this PR.** Bundling a 3-site refactor into the same PR as
the correctness fix would obscure both: reviewers could not easily verify
the keepalive skip in isolation, and a reviewer asking for the refactor to
be split (it's a real candidate for a `TIME_CONSTANTS` accessor or a new
shared helper) could not do so without also rejecting the bug fix. A clean
small PR beats a bundled one.

Recommended follow-up PR (separate, base on `upstream/main`): move the
expression to a small named helper (e.g. `getNoResetCooldownMs()` in
`packages/proxy/src/handlers/proxy-types.ts` or a new
`cooldown-defaults.ts`) and update all 3 sites in one atomic commit. The
`||` vs `??` choice would be settled there.

## Open follow-ups

- Reply to greptile-apps on PR #196 thread pointing at this PR.
- Open `upstream/main` PR to `tombii/better-ccflare` from
  `ao/ccflare-158/keepalive-midstream-skip` (`fix(proxy): ...` so the
  automated release system picks it up).
- Track the `CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS` consolidation as a
  follow-up card.
