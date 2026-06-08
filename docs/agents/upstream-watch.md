# Upstream and Fork Watchlist for Agents

Use this page when reviewing latest changes, planning catch-up work, or deciding whether recent GitHub activity should affect an implementation.

## Review process

Follow a Matt Pocock-style two-axis review:

1. **Pin the fixed point.** For upstream catch-up, compare `origin/main...upstream/main`. For local branch review, compare `origin/main...HEAD` or the issue branch's merge base.
2. **Standards axis.** Check the diff against `CLAUDE.md`, `docs/agents/*.md`, `biome.json`, `tsconfig.json`, and relevant `docs/*.md` files.
3. **Spec axis.** Check the diff against the originating GitHub issue, PRD, PR body, or release notes.
4. Keep the axes separate in the report: standards violations are not the same as spec mismatches.

Useful commands:

```bash
git fetch origin upstream --prune
git rev-list --left-right --count origin/main...upstream/main
git log --oneline --no-merges origin/main..upstream/main
git log --oneline --no-merges upstream/main..origin/main
git diff --name-status origin/main...upstream/main
```

## GitHub snapshot — 2026-06-08

Local fork: `omcdowell/the-best-ccflare`

- `origin/main` is `e29b273` — merge of native provider-prefixed routes/docs.
- Open local issues: `#5` route intent / no surprise Claude→Codex fallback, `#6` live SSE request history persistence, `#7` Codex request-history summary fields.
- Active local branch `fix/issue-6-request-history-persistence` is at `3f3d035` and has additional uncommitted work in the current worktree.
- Autonomous catch-up branch `origin/autonomous/overnight-catchup-feature-parity-branding-stale-payloads` is at `df32d08` and contains route-intent, request persistence reconciliation, Codex usage summaries, stale-token retry, payload compression, upstream UsageCollector, and rebranding changes.

Upstream: `tombii/better-ccflare`

- Latest observed release: `v3.5.21` published 2026-06-04.
- `upstream/main` is `4175208` — removes post-processor worker dead code after PR `#245`.
- `origin/main...upstream/main` showed local fork 6 commits unique, upstream 14 commits unique at the time of review.

Important upstream changes to preserve or port:

1. **Memory-leak fixes in request/usage processing.** Upstream replaced the Bun worker with a main-thread `UsageCollector`, flushed `AsyncDbWriter.drain()`, removed stale worker-health fields, reset `currentEvent` after SSE buffer truncation, and logged `handleEnd` rejections instead of swallowing them. Do not reintroduce the old worker design when merging local request-history work.
2. **Forwarding compressed upstream errors.** Upstream strips `content-encoding` when forwarding upstream model-not-found errors. If response bodies are transformed, ensure headers no longer lie about compression.
3. **Adaptive rate-limit cooldown.** PR `#213` added exponential 429 cooldown with env vars `CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS`, `CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS`, and `CCFLARE_RATE_LIMIT_RESET_STABILITY_MS`. New 429 paths should route through the shared cooldown helper, not local ad-hoc timers.
4. **Anthropic 529 handling.** PR `#236` treats Anthropic `529 overloaded_error` as a temporary cooldown/fallback signal using `Retry-After` or rate-limit reset headers when available.
5. **Manual pause semantics.** PR `#237` stops auto-refresh probes for manually paused accounts (`pause_reason='manual'`). Do not force-route probes past manual pause state.
6. **API auth scope under review.** Open upstream PR `#217` restricts API-key auth to proxy traffic (`/v1/*`, `/messages/*`) and keeps dashboard, `/api/*`, `/health`, SSE, and static assets public. If this lands or is ported, schedulers should dispatch directly through the proxy pipeline instead of calling localhost HTTP endpoints that need auth.
7. **Parallel-session cache misses.** Open upstream issue `#240` reports project/session cache misses when multiple Claude Code projects run in parallel. Be careful with global “most recent session” logic; prefer project-aware/sticky selection.
8. **UTF-8 request/response display.** Open upstream PR `#246` fixes base64 decoding to return UTF-8 strings so non-ASCII bodies are not garbled.

## Local fork behavior agents must preserve

- Native provider-prefixed routes should be explicit: `/v1/codex/responses`, `/v1/openai/*`, and `/v1/anthropic/*` must select the intended provider family.
- Unprefixed Claude/Anthropic traffic such as `POST /v1/messages` must not unexpectedly fall back to Codex accounts unless an explicit compatibility-fallback mechanism says so.
- Request History rows shown as normal completed rows should be persisted, or clearly marked/reconciled as live pending rows.
- Codex-native Request History rows should persist and expose model, token counts, cost when calculable, and throughput when calculable.
