# OpenCodex better-ccflare Compat AQE Ledger

Private controller ledger for the brutal-aqe-loop lock-in pass. Fresh auditors
must not receive this file.

## Compact Goal State

- Artifact ref: `7d04cb73eeb39fb33f5ea209008f3d3ad04f09ea`
- Artifact tree: `7bcd46e6f94002e3731944510fb061f421e87471`
- Artifact hash: `b930c79320473589aa07c742f7bd8320475bddccd4d26d870feacfab4deea6cf`
- Changed-file-list hash: `2ad0257ce47b886e523935262987471142188b368fc0a720f82ed9df029a7dff`
- Current phase / round: source AQE closed; deployment lock-in pending
- Fix cycles used / cap: 2 / 5
- Consecutive invalid rounds: 1 delivery failure on first `7d04cb73` attempt, replaced by fresh `r1c`
- Clean streak / target: 2 / 2
- Open actionable IDs: none
- Human-signed dispositions: none
- Verification passed / failed: source verification passed; live endpoint smoke intentionally not run
- Candidate records queued: `bcf-opencodex-compat-defect-001`, `bcf-opencodex-compat-defect-002`, `bcf-opencodex-compat-verified-001`
- Next action: deploy/pin better-ccflare and run no-quota post-deploy checker
- Rollback: `git revert 7d04cb73eeb39fb33f5ea209008f3d3ad04f09ea`; preserve current deployed better-ccflare image/container until post-deploy verification passes

## Audit Ledger

| id | round | artifact ref | severity | confidence | status | evidence | root cause | blast radius | fix/disposition | verification | candidate id |
|---|---:|---|---|---|---|---|---|---|---|---|---|
| BCF-001 | c7f06d02-r1 | `c7f06d022d6d4393222156aef2d648bab35badb2` | medium | confirmed | fixed | Forced OpenCodex compat cache keepalive replays used `x-better-ccflare-bypass-session: true`; forced-account capacity logic allowed the bypass to ignore model-family exhaustion. | missing boundary | OpenCodex compat cache keepalive could replay to an allowlisted but model-exhausted Claude OAuth account. | Removed bypass-session from the model-scoped capacity check in `selectAccountsForRequest`; added regression for bypass-session plus exhausted forced account. | `bun test packages/proxy/src/handlers/__tests__/account-selector-model-capacity.test.ts`; broad routing pack 309 pass; BHR rounds r1c/r2c CLEAN on `7d04cb73`. | `bcf-opencodex-compat-defect-001` |
| BCF-002 | c7f06d02-r1 | `c7f06d022d6d4393222156aef2d648bab35badb2` | low | confirmed | fixed | Pool-exhausted direct logging persisted `x-better-ccflare-pool-status` from `poolExhaustedResponse.headers.entries()`. | untested branch | Internal diagnostics could remain in persisted response history while still being intentionally client-visible. | Added shared `sanitizeResponseHeaders`; applied it to pool-exhausted history; added tests proving client header remains and persisted header is absent. | `bun test packages/proxy/src/__tests__/auto-refresh-probe-filter.test.ts packages/http-common/src/__tests__/headers.test.ts`; broad routing pack 309 pass; BHR rounds r1c/r2c CLEAN on `7d04cb73`. | `bcf-opencodex-compat-defect-002` |
| BCF-003 | 7d04cb73-r1c | `7d04cb73eeb39fb33f5ea209008f3d3ad04f09ea` | n/a | confirmed | verified-solid | Fresh BHR Round 1 found no surviving findings. It verified safe default exclusion, explicit compat env+allowlist, request shaping, internal-header trust boundary, cache replay policy, forced-account capacity/allowlist, docs, and no-quota checker behavior. | n/a | Source artifact readiness for OpenCodex Claude OAuth compat. | No fix required. | `/tmp/bhr-round1-7d04cb73-r1c.md`; targeted audit tests 205 pass; typecheck and checker tests pass. | `bcf-opencodex-compat-verified-001` |
| BCF-004 | 7d04cb73-r2c | `7d04cb73eeb39fb33f5ea209008f3d3ad04f09ea` | n/a | confirmed | verified-solid | Fresh BHR Round 2 independently found no surviving findings on the same source artifact and emitted `full_gate_status: PASS`. | n/a | Second required high-blast clean round. | No fix required. | `/tmp/bhr-round2-7d04cb73-r2c.md`; targeted audit tests 205 pass; `scripts/check-opencodex-compat.test.sh`; `bun run typecheck`. | `bcf-opencodex-compat-verified-001` |

## Brutal AQE Loop -- CLOSED

- Artifact and immutable ref: `7d04cb73eeb39fb33f5ea209008f3d3ad04f09ea`
- Blast class / action floor / clean target: high / low / 2
- Fix cycles and audit rounds: 2 fix cycles after actionable findings; 2 valid clean rounds on final artifact
- Invalid reruns and delivery failures: one delivery failure during first final-artifact attempt due model transport reconnects; not counted
- Clean rounds and evidence: `/tmp/bhr-round1-7d04cb73-r1c.md`, `/tmp/bhr-round2-7d04cb73-r2c.md`
- Verification commands/artifacts: targeted routing/security pack 309 pass; BHR targeted tests 205 pass; `bun run lint`; `bun run typecheck`; `bun run format`; `bun run build`; `bun run test:opencodex-compat-checker`; `git diff --check`
- Candidate records queued: see `docs/aqe/opencodex-better-ccflare-compat-candidates.yaml`
- Human dispositions: none
- Residual risks and non-proof: no live Anthropic/OpenAI model smoke was run; fallback drill remains intentionally unforced
- Rollback handles: `git revert 7d04cb73eeb39fb33f5ea209008f3d3ad04f09ea`; preserve previous deployed container/image until post-deploy verification passes
- Composite-audit decision: PASS; this is a single-artifact high-blast change and the two clean rounds were run on the final artifact
- Re-packet decision: not required before deploy; next task is operational deploy/pin and no-quota runtime verification
- Codex goal state: not requested
