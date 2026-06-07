# Handoff — the-best-ccflare autonomous run

> **Placeholder** — completed in U8 after all implementation units land.

## What changed

_(To be filled by U8.)_

## Issue status

| Issue | Title | Status |
| --- | --- | --- |
| #5 | Prevent Claude traffic from unexpectedly falling back to Codex accounts | Open — U3 |
| #6 | Request History live SSE rows not yet persisted | Open — U7 |
| #7 | Codex request history missing model/token/cost/throughput | Open — U4 |

## Tests run

_(To be filled by U8.)_

## Skipped upstream deltas

See `STATUS.md` **U1** section for full table. Summary:

- **Merged:** PR #245 UsageCollector migration, model-not-found `content-encoding` strip, SSE `currentEvent` reset, CLI build worker removal, health type narrowing.
- **Skipped:** upstream `3.5.21` version bump; README/cli README branding (U2); redundant AsyncDbWriter-only commits already covered by collector `drain()`.
- **Fork preserved:** Codex Responses API usage parsing, `clientPath`/`upstreamPath`/`routingMode` observability, native passthrough routes/tests, `HandleProxyOptions`.

## Owner-only tasks

- Provide/rotate real OAuth/API credentials for manual smoke if needed.
- Approve production rollout/restart of the live instance on port **8080**.
- Review, merge, publish, and confirm/close GitHub issues #5/#6/#7.

## Production rollout notes

_(To be filled by U8.)_

---

## Safe second-instance test harness (U0 baseline)

Use this for all proxy/dashboard smoke tests during the run. **Never** stop, restart, or send test traffic through the live production instance on port **8080**.

### Instance

```bash
# Fresh temp DB (do not point at ~/.config/better-ccflare/better-ccflare.db in production)
export BETTER_CCFLARE_DB_PATH="/tmp/the-best-ccflare-test.db"
bun start --serve --port 8081
```

- Startup takes ~15s; wait before curling.
- Local dev/testing port per `CLAUDE.md`: **8081** (production runs on **8082**; live `the-best-ccflare` on **8080**).
- U0 smoke: server bound to `0.0.0.0:8081` with temp DB; responded (health may return 503 while worker warms up).

### Database

- Default prod DB: `~/.config/better-ccflare/better-ccflare.db` (Windows: `%LOCALAPPDATA%\better-ccflare\better-ccflare.db`).
- Tests: always `BETTER_CCFLARE_DB_PATH` to a temp or copied snapshot — never mutate the live production DB.
- PostgreSQL: set `DATABASE_URL=postgresql://...` when testing PG migrations (mirror every SQLite change in `migrations-pg.ts`).

### Anthropic / account testing restrictions

From `CLAUDE.md` — **mandatory**:

- **NEVER** `curl` the Anthropic endpoint directly.
- **NEVER** route automated/scripted tests through a `claude` OAuth account (ban risk).
- The `claude` account is only for real Claude Code sessions.
- Unit/integration tests: use non-Anthropic accounts (`ollama`, `litellm`, `omniroute`, etc.) and force-route with header `x-better-ccflare-account-id`.
- OpenRouter smoke: model `z-ai/glm-4.5-air:free`:

```bash
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"z-ai/glm-4.5-air:free","messages":[{"role":"user","content":"test"}],"max_tokens":10}'
```

- Claude/Anthropic behavior through the proxy: prefer `claude -p` pointed at the **second test instance** (port 8081) — Anthropic-approved; still no raw Anthropic curls.

### Forbidden generated files

Never read/edit/search/commit:

- `packages/proxy/src/inline-worker.ts`
- `packages/database/src/inline-vacuum-worker.ts`
- `packages/database/src/inline-integrity-check-worker.ts`

If `bun run build` touches them: `git checkout -- <path>` before commit. Use `git add <specific-files>`, not `git add .`.
