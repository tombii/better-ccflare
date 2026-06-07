# Handoff — the-best-ccflare autonomous run

Branch: `autonomous/overnight-catchup-feature-parity-branding-stale-payloads`  
Remote: `origin` → `https://github.com/omcdowell/the-best-ccflare.git`  
Version: **3.5.20** (unchanged — release system owns bumps)

## What changed (U0–U7)

| Unit | Summary |
| --- | --- |
| U0 | Baseline, upstream comparison, issue staleness checks, safe second-instance harness |
| U1 | Ported upstream PR #245 (`UsageCollector` on main thread); removed post-processor worker; preserved fork Codex observability hooks |
| U2 | Rebranded user-visible/docs/package metadata to **the-best-ccflare**; npm package, CLI binary, env vars, headers, and config paths remain **better-ccflare** |
| U3 | Issue **#5** — unprefixed `POST /v1/messages` excludes Codex by default; opt-in via `x-better-ccflare-allow-providers: codex` |
| U4 | Issue **#7** — Codex `/v1/codex/responses` usage/model/cost/throughput parity via `UsageCollector` + `requestedModel` fallback |
| U5 | Stale OAuth 401 → one token refresh + single retry; auto-refresh probes staggered with 0–30s jitter; `/api/token-health` exposes `refreshRuntime` |
| U6 | Full payloads gzip-compressed (`request_payloads.compressed`); optional AES-256-GCM; SQLite + PostgreSQL migrations |
| U7 | Issue **#6** — metadata persisted before SSE summary; dashboard reconciles live pending rows on reload |

## Issue status (fork: omcdowell/the-best-ccflare)

| Issue | Title | Code status | Close? |
| --- | --- | --- | --- |
| [#5](https://github.com/omcdowell/the-best-ccflare/issues/5) | Prevent Claude→Codex surprise fallback | Fixed U3 | Owner confirms on live instance |
| [#6](https://github.com/omcdowell/the-best-ccflare/issues/6) | Live SSE rows not persisted | Fixed U7 | Owner confirms on live instance |
| [#7](https://github.com/omcdowell/the-best-ccflare/issues/7) | Codex history missing model/tokens/cost | Fixed U4 | Owner confirms with Codex account |

Per `CLAUDE.md`, do **not** auto-close issues — wait for reporter confirmation.

## Tests run (U8 final verification)

| Step | Result | Notes |
| --- | --- | --- |
| `bun run build` | ✅ pass | v3.5.20; dashboard + CLI binary; forbidden inline-worker files reverted after build |
| `bun run lint` | ✅ exit 0 | 201 pre-existing warnings; `--write` fixed 501 files (CRLF drift) — **reverted, not committed** |
| `bun run typecheck` | ✅ pass | |
| `bun run format` | ✅ pass | No additional fixes after lint revert |
| `bun test` | ⚠️ **1554 pass / 31 fail** | Same pre-existing Windows baseline as U0; **no regressions** (+54 tests vs U0) |
| Second-instance smoke (8081) | ✅ partial | Temp DB; `/api/health` 503 (warming), `/api/accounts` `[]`, dashboard 200; **port 8080 not touched** |
| GitNexus `detect_changes` | ❌ unavailable | `npx gitnexus` failed — tree-sitter npm install error on Windows (same as U6/U7) |

### Windows baseline failures (31, unchanged)

Path validator (20), database backup/migration (16), auto_vacuum/mmap (8), CLI SSL paths (2), CLI sanitize timeout (1), API auth setup (1). CI (Linux) expected green.

## Owner-only smoke (credentials required)

No non-Anthropic accounts in this worktree DB. Run on a **second instance** (never port 8080):

```bash
export BETTER_CCFLARE_DB_PATH="/tmp/the-best-ccflare-smoke.db"
bun start --serve --port 8081
# wait ~15s

# OpenRouter (force-route if needed)
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"z-ai/glm-4.5-air:free","messages":[{"role":"user","content":"test"}],"max_tokens":10}'

# Issue #5 — should NOT use Codex without header (expect 503/no Codex account if only Codex configured)
# Issue #5 opt-in:
curl -H "x-better-ccflare-allow-providers: codex" ...

# Issue #7 — native Codex route (requires Codex OAuth account in test DB)
curl -X POST http://localhost:8081/v1/codex/responses ...

# Issue #6 — dashboard Request History: complete row should survive reload; failed writes show "Not saved"

# Claude behavior: prefer `claude -p` pointed at localhost:8081 — never curl Anthropic directly
```

## Skipped upstream deltas

See `STATUS.md` **U1**. Summary: merged UsageCollector migration + low-risk streaming fixes; skipped upstream `3.5.21` bump and upstream README branding; fork native routes and Codex observability preserved.

## Production rollout (owner-only)

1. Review branch diff vs `origin/main` (9 commits, ~90 files).
2. Merge when satisfied (`git merge --no-ff` if external contributor rules apply).
3. **Do not restart live port 8080** until approved; test on 8081/8082 first.
4. Publish/npm release handled by existing release system — **do not bump version manually**.
5. After merge to main, run `npx gitnexus analyze` if GitNexus is available.
6. Confirm issues #5/#6/#7 on production, then close.

## Branch diff guardrails

- `git diff --name-only origin/main...HEAD` — no forbidden generated files (`inline-worker.ts`, `inline-vacuum-worker.ts`, `inline-integrity-check-worker.ts`).
- `apps/cli/README.md` untouched.
- Versions unchanged at 3.5.20.

---

**result:** U0–U8 complete on branch `autonomous/overnight-catchup-feature-parity-branding-stale-payloads`; pushed to origin. Owner: merge/publish, live 8080 rollout, credential smoke, issue confirmation/closure.
