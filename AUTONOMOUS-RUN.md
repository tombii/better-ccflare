# Autonomous Build — Overnight Run Prompt

> Paste everything below the line into a fresh **Opus** Claude Code session launched
> **inside this worktree**: `D:\source\the-best-ccflare-autonomous-run`
> Run it autonomously to completion — no input, no context rot.

---

## MANDATE — supreme rule, overrides everything below

You are completing **catch up `the-best-ccflare` with upstream `better-ccflare`, close outstanding issues #5/#6/#7, bring native Codex paths to Claude-path feature parity, rebrand to `the-best-ccflare`, fix stale-request auto-refresh with jitter, and persist compressed full message payloads for later analytics** for Oliver McDowell on **the-best-ccflare** (a load-balancer proxy for Claude Code/API traffic with request analytics, OAuth/token health, native provider routes, and multi-account rate-limit avoidance), working the queue below.

**You orchestrate; you do not implement.** You never Read/Grep/Glob/Edit/Write app or content files, and never spawn Explore/general-purpose subagents. For each unit you: pick it from `STATUS.md`, write a task packet, dispatch **Composer 2.5 executor**, review its diff against the acceptance criteria, commit, flip `STATUS.md`. The only files your hands touch are `STATUS.md`, `HANDOFF.md`, this prompt, and git. The executor is highly capable — route *all* exploration, authoring, and verification to it, and don't be frugal: a clean orchestrator context and throughput are the goals.

**Invoke** via the PowerShell tool (`agent` = agent.ps1, not on Bash PATH):

```
agent -p --model composer-2.5 --force --workspace "D:\source\the-best-ccflare-autonomous-run" --output-format json "<task packet>"
```

- `--force` auto-applies edits + runs commands, so **dispatch only on a clean/committed tree** (commit each unit first, so its edits stay reviewable).
- Redirect stdout to a file — never let raw JSON hit context — then extract only `.result`: `... | Out-File "$env:CLAUDE_JOB_DIR\tmp\executor-<unit>.json" -Encoding utf8` (bare `>` corrupts it under PS 5.1). Read `.result` via `ctx_execute_file`.
- Never run `agent` inside `ctx_execute` (the sandbox discards its FS writes). Long units: `--output-format stream-json` to a logfile + a `Monitor` on the end event and error signatures.

**Task packet** (acceptance criteria = the contract you review against):

```
Goal: <one sentence — the unit's deliverable>
Context: read STATUS.md, AUTONOMOUS-RUN.md, CLAUDE.md, README.md, package.json, docs/, GitHub issues #5/#6/#7; match
         their convention and tone; derive ALL specifics from the real repo — never invent.
Acceptance criteria: <the unit's Acceptance bullets, verbatim>
Scope: create/edit only <paths for this unit>; touch nothing else.
Method: use /tdd where code is involved. Before editing any symbol, run GitNexus impact analysis if available and report/heed HIGH or CRITICAL risk. For GitHub issues, run the mandatory staleness check from CLAUDE.md first.
Verify: run `bun run build && bun run lint && bun run typecheck && bun run format && bun test` clean; check generated artifacts exist; revert and never commit forbidden generated inline-worker files.
```

If the result misses acceptance, re-dispatch with specific corrections.

---

## OPERATING RULES

- **One unit at a time, fully:** dispatch → verify → commit (`<prefix>: <unit> …`) → flip `STATUS.md` → next. Never interleave; uncommitted work doesn't survive compaction. **(This and the orchestrate-only rule above are the two you most often break — hold them.)**
- **Re-read on every resume/compaction:** `STATUS.md` (+ `AUTONOMOUS-RUN.md`, `CLAUDE.md`, `README.md`, `package.json`, `docs/`) is the source of truth — trust it over memory. If anything is dirty on first run, commit it before dispatching.
- **Never ask the user.** At each fork pick the most defensible option and log it under `## Assumptions & for-Oliver review` in `STATUS.md`. Things only Oliver can do (supply/rotate OAuth or API credentials, approve production rollout, restart the live 8080 instance, merge the branch, publish packages, and confirm/close issues) — scaffold thoroughly and flag; never let them block the run.
- **Stay faithful to the real product:** it is a self-hosted Claude Code/API proxy with multi-provider account pools, explicit native provider-prefixed routes, request-level analytics, SQLite by default with PostgreSQL support, OAuth/token health, and rate-limit avoidance. Claude/Anthropic `/v1/messages` behavior must stay stable; Codex-native routes must be explicit and not surprise-route Claude traffic; request history must be persisted and analytically useful. Never use the `claude` account or curl Anthropic directly in tests; force non-Anthropic test accounts. Do not restart or test against the live `the-best-ccflare` instance on port 8080.
- **Repo guardrails:** only modify root `README.md`, never `apps/cli/README.md`; never read/edit/search/commit `packages/proxy/src/inline-worker.ts`, `packages/database/src/inline-vacuum-worker.ts`, or `packages/database/src/inline-integrity-check-worker.ts`; if a build touches them, `git checkout --` those paths before committing. Use `git add <specific-files>`, not `git add .`. Do not bump versions.
- **Database guardrails:** every SQLite migration in `packages/database/src/migrations.ts` must be mirrored in `packages/database/src/migrations-pg.ts`; keep existing encrypted/compressed payload conventions where present; avoid mutating the live production DB unless using a deliberate copy/snapshot.
- **Testing guardrails:** run local/unit/integration tests; for proxy smoke tests start a second instance only (for example `bun start --serve --port 8081` with a temp or copied DB). Never stop/restart port 8080. It is OK and preferred to test Claude/Anthropic behavior through real Claude Code using `claude -p` pointed at the second test instance; this is Anthropic-approved. Still never curl Anthropic directly, never raw-script the Anthropic endpoint, and never send test traffic through the live 8080 instance. For OpenRouter tests use model `z-ai/glm-4.5-air:free` and force-route with `x-better-ccflare-account-id`.
- **Protect context:** one line of narration before/after each batch; write artifacts to files (a one-line confirmation back, never the content); never read binaries, lockfiles, or generated assets — script out just what you need.
- **Never** send product data to external services other than normal GitHub repo/issue fetch and final branch push, do visual polish, or merge/package/submit — those are Oliver's steps.

## WORK QUEUE (dependency order; author in listed order)

### U0 — Baseline, upstream catch-up plan, and safe test harness [1] → `STATUS.md`, `HANDOFF.md`
- Establish the exact baseline before code work: clean worktree, branch, upstream/origin refs, current open issues, issue staleness checks, and forbidden-file guardrails.
- If missing, add/fetch upstream `https://github.com/tombii/better-ccflare.git` without changing remotes destructively; compare upstream main with origin main and produce the catch-up strategy in `STATUS.md` assumptions.
- Create an empty `HANDOFF.md` placeholder for the final unit.
- Define and smoke-check a safe second-instance test harness that never touches port 8080 and uses a temp/copied DB.
- **Acceptance:** `git status --short --branch` is clean before implementation units.
- **Acceptance:** GitHub issues #5, #6, #7 are fetched/summarized and the `git log origin/main --since=... --no-merges -- <relevant-paths>` staleness check is recorded for each.
- **Acceptance:** upstream comparison strategy is recorded, including conflicts/risks and preservation of fork-specific behavior.
- **Acceptance:** `HANDOFF.md` exists and the second-instance/DB/Anthropic test restrictions are captured.
- **Acceptance:** `bun run build && bun run lint && bun run typecheck && bun run format && bun test` baseline either passes or failures are categorized as pre-existing with logs; `STATUS.md` rows → ✅.

### U1 — Catch up with upstream `better-ccflare` while preserving fork behavior [3] → upstream merge/cherry-pick diff
- Bring in relevant upstream `better-ccflare` changes from `upstream/main` to the current branch, resolving conflicts in favor of current fork safety, database, provider, and request-history behavior.
- Preserve repo instructions, security fixes, provider routes, and existing issue-work direction; do not overwrite fork-specific docs/branding decisions that later units depend on.
- **Acceptance:** upstream delta is merged/cherry-picked or intentionally skipped with rationale in `STATUS.md`.
- **Acceptance:** conflicts are resolved with tests covering any touched provider/proxy/database paths.
- **Acceptance:** forbidden generated files are not committed and root/app package versions are not bumped.
- **Acceptance:** `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes; `STATUS.md` rows → ✅.

### U2 — Rebrand visible/package/docs surface to `the-best-ccflare` [2] → root docs, packages, UI constants
- Update branding from `better-ccflare`/old fork references to `the-best-ccflare` across visible CLI/UI/docs/package surfaces where appropriate, while preserving historical upstream attribution where contextually correct.
- Do not edit `apps/cli/README.md`; do not bump versions; preserve binary/command compatibility only if the real repo requires it and record the decision.
- **Acceptance:** root `README.md`, package metadata, dashboard/user-visible labels, docs links, repository/homepage/bugs URLs, and install/run commands consistently present `the-best-ccflare` where current ownership/branding is intended.
- **Acceptance:** legacy `ccflare`/`better-ccflare` mentions left behind are either compatibility strings, historical attribution, dependency/package names that must remain, or documented exceptions.
- **Acceptance:** no disallowed README/generated files are touched; `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes; `STATUS.md` rows → ✅.

### U3 — Issue #5: explicit route intent, no surprise Claude→Codex fallback [2] → provider selection/proxy tests
- Fix routing so unprefixed Claude/Anthropic traffic such as `POST /v1/messages` cannot unexpectedly fall back to Codex accounts when Claude accounts are unavailable/rate-limited.
- Keep native provider-prefixed routes such as `POST /v1/codex/responses` selecting Codex accounts; if cross-provider fallback remains, require an explicit header/config/setting and document it.
- **Acceptance:** tests prove `/v1/messages` excludes Codex accounts by default, including unavailable/rate-limited Claude pools.
- **Acceptance:** tests prove `/v1/codex/responses` still selects Codex accounts and any explicit compatibility fallback path is opt-in only.
- **Acceptance:** dashboard/config/docs represent the route-intent behavior accurately if user-facing settings change.
- **Acceptance:** issue #5 expected behavior is satisfied; `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes; `STATUS.md` rows → ✅.

### U4 — Codex-native path feature parity with old Claude pathing [4] → Codex provider/proxy/database/dashboard tests
- Audit the old Claude `/v1/messages` path and implement missing Codex-native `/v1/codex/responses` parity for authentication, routing, streaming/non-streaming handling, errors, account health, usage extraction, request observability, analytics, and dashboard/API representation.
- Treat issue #7 as part of parity: Codex request history rows must persist/expose model, token counts, cost when calculable, and output tokens/sec when calculable.
- **Acceptance:** parity checklist in `STATUS.md` maps Claude-path features to Codex-native status with implemented gaps or explicit non-applicable rationale.
- **Acceptance:** Codex streaming/non-streaming tests cover model, usage/tokens, cost mapping, latency/throughput, account id, billing type, and errors.
- **Acceptance:** `/api/requests` and dashboard request history show Codex summaries comparably to Claude rows where data exists.
- **Acceptance:** issue #7 expected behavior is satisfied; `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes; `STATUS.md` rows → ✅.

### U5 — Stale request error recovery with randomized auto-refresh [3] → OAuth/provider refresh logic and tests
- Diagnose stale request/session/token errors and implement automatic refresh/retry behavior with bounded random jitter so accounts do not synchronize or annoy Anthropic.
- Keep refresh conservative, observable, and provider-appropriate; never make real Anthropic calls in tests.
- **Acceptance:** tests reproduce the stale request error path and prove auto-refresh/retry resolves it when credentials can refresh.
- **Acceptance:** refresh scheduling includes bounded randomized delay/jitter, backoff/rate limiting, logs/audit events, and dashboard/API status where appropriate.
- **Acceptance:** failed refreshes degrade safely without request storms, credential leakage, or live 8080 disruption.
- **Acceptance:** `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes; `STATUS.md` rows → ✅.

### U6 — Persist compressed full message payloads for later analytics [4] → database migrations/repository/API tests
- Permanently store full request and response message payloads in the database with appropriate compression and existing encryption/security conventions, so future agentic-usage analysis can reconstruct conversations/events.
- Support SQLite and PostgreSQL migrations, retention/query behavior, repository save/load APIs, and dashboard/API details without breaking existing request history.
- **Acceptance:** SQLite schema and migrations add durable compressed payload storage; PostgreSQL schema/migrations mirror it.
- **Acceptance:** save paths persist full inbound/outbound message payloads for Claude and Codex/native routes, including streaming final aggregation where available.
- **Acceptance:** read paths/API can retrieve payloads for authorized dashboard/detail use without inflating normal list endpoints unnecessarily.
- **Acceptance:** tests cover compression round-trip, legacy rows, null/large payloads, cleanup/retention behavior, and both SQLite/PG migration shape.
- **Acceptance:** `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes; `STATUS.md` rows → ✅.

### U7 — Issue #6: persisted/live request history reconciliation [2] → request stream/cache/post-processor tests
- Ensure Request History never presents a completed row as durable unless it is persisted, or clearly marks it pending and reconciles once persistence lands.
- Prefer persistence-before-final-SSE if feasible; otherwise implement `pendingPersistence`/reconciliation without silently dropping recent live rows.
- **Acceptance:** tests reproduce live SSE row followed by `/api/requests` reload and verify the row is persisted or visibly pending/reconciled.
- **Acceptance:** worker/post-processor failures are observable and do not create misleading completed history rows.
- **Acceptance:** dashboard query cache behavior preserves user trust and avoids duplicate rows.
- **Acceptance:** issue #6 expected behavior is satisfied; `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes; `STATUS.md` rows → ✅.

### U8 — Integration smoke, docs, issue mapping, and branch push [2] → `HANDOFF.md`
- Run final verification, including a second-instance smoke test on a non-8080 port if credentials/non-Anthropic accounts are available; otherwise document exact owner-only smoke steps.
- Update docs for route intent, Codex parity, payload persistence/compression, stale-refresh jitter, and branding changes.
- Write `HANDOFF.md`: what changed, issue #5/#6/#7 status, tests run, any skipped upstream deltas, owner-only tasks, and production rollout notes.
- Re-run the build so `apps/cli/dist/better-ccflare` and dashboard build artifacts reflect all units; revert forbidden generated files before committing.
- `git push` the branch, then **stop** — do not merge or publish. End with one `result:` line: units done + what remains for Oliver.
- **Acceptance:** every status row is accurate; `HANDOFF.md` is complete and concise.
- **Acceptance:** final `git diff --name-only origin/main...HEAD` contains only intended files and no forbidden generated files.
- **Acceptance:** `bun run build && bun run lint && bun run typecheck && bun run format && bun test` passes or any unavoidable external-credential smoke gaps are owner-only with exact commands.
- **Acceptance:** branch is pushed to origin; `STATUS.md` rows → ✅.
