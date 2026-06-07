# Autonomous Run Status — the-best-ccflare

Last updated: 2026-06-07 (U1 UsageCollector migration)

Worktree: `D:\source\the-best-ccflare-autonomous-run`  
Branch: `autonomous/overnight-catchup-feature-parity-branding-stale-payloads`  
Remotes: `origin` → `https://github.com/omcdowell/the-best-ccflare.git`; `upstream` → `https://github.com/tombii/better-ccflare.git` (added U0)

## Queue

| Unit | Item | Status | Notes |
| --- | --- | --- | --- |
| U0 | Baseline clean worktree, open issues, staleness checks, upstream comparison, safe second-instance test harness | ✅ done | See sections below; `HANDOFF.md` placeholder created. |
| U1 | Catch up with upstream `better-ccflare` while preserving fork behavior | ✅ done | PR #245 `UsageCollector` migration; fork Codex SSE hooks merged; see **U1** section below. |
| U2 | Rebrand visible/package/docs surface to `the-best-ccflare` | ✅ done | Root README, package metadata, dashboard UI, docs links; compatibility preserved — see **U2** section below. |
| U3 | Issue #5: explicit route intent; no surprise Claude-to-Codex fallback | ✅ done | `/v1/messages` excludes Codex by default; native `/v1/codex/responses` unchanged; opt-in via `x-better-ccflare-allow-providers: codex`. |
| U4 | Codex-native path feature parity with old Claude pathing, including issue #7 fields | ⬜ todo | Model/tokens/cost/throughput and observability parity where data exists. |
| U5 | Stale request error recovery with randomized auto-refresh | ⬜ todo | Bounded jitter/backoff; no real Anthropic calls in tests. |
| U6 | Persist compressed full message payloads for later analytics | ⬜ todo | SQLite and PostgreSQL migrations; compression/security conventions; list endpoints stay lean. |
| U7 | Issue #6: persisted/live request history reconciliation | ⬜ todo | Persist-before-final-SSE or pending/reconcile behavior. |
| U8 | Integration smoke, docs, handoff, final verification, push branch | ⬜ todo | Use a second instance only; never touch live port 8080. |
| Owner | Provide/rotate real OAuth/API credentials if needed for manual smoke | 🔒 owner-only | `claude -p` smoke tests are allowed/preferred when pointed at a second test instance; never raw-curl Anthropic or use live port 8080. |
| Owner | Approve production rollout/restart of live port 8080 instance | 🔒 owner-only | Run must not restart or test against live 8080. |
| Owner | Review, merge, publish, and confirm/close GitHub issues | 🔒 owner-only | Run pushes branch only; no merge/publish/issue closure. |

---

## U0 — Baseline (2026-06-07)

### Worktree

- `git status --short --branch`: clean on `autonomous/overnight-catchup-feature-parity-branding-stale-payloads` (ahead of `origin/main` by scaffold commit `607ec693`).
- `bun install` required once (missing `node_modules`); lockfile unchanged after revert — environment-only, not a code defect.

### GitHub issues #5 / #6 / #7

#### Issue #5 — Prevent Claude traffic from unexpectedly falling back to Codex accounts

- **Opened:** 2026-06-04T00:22:24Z | **State:** OPEN | **Labels:** enhancement
- **Problem:** Unprefixed `POST /v1/messages` can fall back to Codex when Claude accounts are unavailable, even with Codex auto-fallback off.
- **Desired:** Route intent explicit — `/v1/messages` must not surprise-route to Codex; `/v1/codex/responses` selects Codex; any cross-provider fallback must be opt-in.
- **Staleness check** (`git log origin/main --since='2026-06-04' --oneline --no-merges` on routing/selector paths):

```
7a18b843 feat: add native OpenAI and Anthropic provider routes with docs
e6418c75 feat: native Codex streaming passthrough and request observability
bec706b1 feat: add native Codex Responses passthrough at POST /v1/codex/responses
```

- **Verdict:** **Still applies.** Recent work added native provider-prefixed routes and Codex passthrough but does not address unprefixed `/v1/messages` excluding Codex on pool exhaustion. Issue note: "needs more design before implementation."

#### Issue #6 — Request History live SSE rows not yet persisted

- **Opened:** 2026-06-04T10:40:37Z | **State:** OPEN | **Comments:** 4
- **Problem:** Dashboard shows live SSE rows from `/api/requests/stream` that disappear after reload from persisted `/api/requests`.
- **Desired:** Persist before showing completed row, or mark `pendingPersistence` and reconcile.
- **Staleness check** (`useRequestStream`, `RequestsTab`, `post-processor.worker`, `database-operations`, `requests` handler):

```
e6418c75 feat: native Codex streaming passthrough and request observability
```

- **Verdict:** **Still applies.** Codex observability touched post-processor/streaming but live-vs-persisted reconciliation in dashboard cache is unchanged.

#### Issue #7 — Codex request history missing model/token/cost/throughput

- **Opened:** 2026-06-04T10:46:07Z | **State:** OPEN
- **Problem:** Codex-native `/v1/codex/responses` rows persist but `model`, `total_tokens`, `cost_usd`, `output_tokens_per_second` are null.
- **Staleness check** (codex provider, post-processor, observability tests, request repository):

```
e6418c75 feat: native Codex streaming passthrough and request observability
bec706b1 feat: add native Codex Responses passthrough at POST /v1/codex/responses
```

- **Verdict:** **Still applies.** Native Codex path exists; usage/model extraction into `saveRequest` summary fields remains incomplete per issue reporter observation.

### Upstream comparison strategy (U1 input)

**Merge base:** `c8b67f1a81628f6bf10c0eb9fee13f46c6e115c8`  
**Versions:** `origin/main` = **3.5.20** | `upstream/main` = **3.5.21**

#### Fork-only commits (preserve in U1)

| Commit | Summary |
| --- | --- |
| `bec706b1` / `255e58c9` | Native Codex Responses passthrough `POST /v1/codex/responses` |
| `e6418c75` | Native Codex streaming passthrough + request observability |
| `7a18b843` | Native OpenAI + Anthropic provider-prefixed routes + docs |

These are the fork's active feature work (issues #3/#4 lineage) and **must not be overwritten** by upstream merge.

#### Upstream-only commits (candidates to merge in U1)

| Commit | Summary | Risk if merged blindly |
| --- | --- | --- |
| `315440fa` / `5b3b7fb1` | **Replace Bun post-processor worker with main-thread `UsageCollector`** (PR #245 memory-leak fix) | **HIGH** — deletes `post-processor.worker.ts`, adds `usage-collector.ts`, removes `usage-worker-controller.ts`. Direct conflict with fork's Codex observability/post-processor work. |
| `51540b44` / `8926f5be` | Strip `content-encoding` on upstream model-not-found errors | Low — independent fix |
| `61f4007a` | Reset `currentEvent` after SSE buffer truncation | Medium — touches streaming path shared with Codex |
| `16748635`, `ba89fe28`, `921062eb`, `eb9817a6`, `c78f2c7d` | AsyncDbWriter drain/shutdown, handleEnd logging, type narrowing | Medium — overlaps request persistence (#6) |
| `41752084` | Remove post-processor dead code after PR #245 | Depends on worker removal |
| `d8cb0512` | Version bump to 3.5.21 | **Skip** — run must not bump versions |

#### Recommended U1 approach

1. **Cherry-pick low-risk fixes first:** content-encoding strip, SSE `currentEvent` reset, AsyncDbWriter drain/logging (verify against fork tests).
2. **Port PR #245 (`UsageCollector`) deliberately:** treat as architectural migration, not a blind merge. Reconcile with fork's `post-processor.worker.ts` Codex observability paths — likely re-implement observability hooks in `usage-collector.ts` rather than keeping the worker.
3. **Do not take upstream version bump** (`3.5.21`); release system owns versions.
4. **Do not take upstream README/cli README** changes that conflict with U2 `the-best-ccflare` branding.
5. **Regression focus after merge:** native Codex/OpenAI/Anthropic prefixed routes, request history persistence, account selector/failover (#5), streaming usage extraction (#7).
6. **Conflict resolution default:** favor fork safety (explicit routes, no surprise Codex fallback direction, PG migration parity) while accepting upstream security/reliability fixes.

### Baseline verification

| Step | Result | Notes |
| --- | --- | --- |
| `bun run build` | ✅ pass | v3.5.20; dashboard + CLI binary built. Revert forbidden inline-worker files after build. |
| `bun run lint` | ✅ pass (exit 0) | 202 warnings; auto-fixes 530 files — **pre-existing formatting drift**; reverted, do not commit mass format. |
| `bun run typecheck` | ✅ pass | `tsc --noEmit` clean. |
| `bun run format` | ✅ pass (exit 0) | Would fix 530 files — same pre-existing drift; reverted. |
| `bun test` | ⚠️ 1500 pass / **31 fail** | Pre-existing; see below. |

#### Pre-existing test failures (31) — Windows / environment

All failures observed on **Windows 10** worktree; categorized from baseline log:

| Category | Count | Likely cause |
| --- | ---: | --- |
| Path Validator security tests | 20 | Windows path resolution / whitelist semantics differ from Unix |
| Database backup / migration tests | 16 | Temp DB paths, backup retention on Windows |
| `bootstrapAutoVacuum` / `incrementalVacuum` | 10 | SQLite file-backed DB behavior on Windows |
| `configureSqlite` mmap_size | 6 | PRAGMA / bun:sqlite on Windows |
| CLI SSL cert validation | 2 | Path handling |
| CLI security sanitize (timeout) | 1 | 5s timeout exceeded on Windows |
| API Authentication suite | 1 | Environment/setup |
| `ensureSchema` auto_vacuum | 2 | File-backed DB on Windows |

**Not regressions introduced by this run** — no app source edited in U0.

### Second-instance harness

Documented in `HANDOFF.md`. U0 smoke: `BETTER_CCFLARE_DB_PATH=<temp>` + `bun start --serve --port 8081` — server started, HTTP response received; **port 8080 not touched**.

---

## U1 — Upstream UsageCollector migration (2026-06-07)

### Merged (architectural + low-risk fixes)

| Upstream commit | What landed |
| --- | --- |
| `315440fa` / `5b3b7fb1` | **PR #245:** main-thread `UsageCollector` replaces Bun post-processor worker; deleted `post-processor.worker.ts`, `usage-worker-controller.ts`; added `usage-collector.ts`; `initProxy` / `drainUsageCollector` / `getUsageCollectorHealth`; server shutdown drains collector |
| `51540b44` / `8926f5be` | Strip `content-encoding` on upstream model-not-found raw responses (`withSanitizedProxyHeaders`) |
| `61f4007a` | Reset `currentEvent` after SSE buffer truncation (in `usage-collector.ts`) |
| `41752084` | Remove post-processor worker build/embed steps from `apps/cli` build scripts |
| `c78f2c7d` / `16748635` | Narrow `usageWorker` health type to `{ state: string }` in `packages/types` + health handler |

### Fork-specific behavior preserved in `usage-collector.ts`

- Codex/OpenAI Responses API: `applyResponsesApiUsage`, `response.completed`/`response.created` in `shouldParseSSEData`, nested `json.response.usage`, `input_tokens_details`
- `saveRequest` uses `clientPath ?? path`, plus `upstreamPath` and `routingMode`
- `HandleProxyOptions` (clientPath/upstreamPath/nativePassthrough) unchanged in `proxy.ts`
- `response-handler.ts` fork fields + `loggedPath` logic; now calls `getUsageCollector()` with `fireAndForgetEnd`
- Native route files and passthrough tests kept

### Skipped upstream deltas

| Commit | Reason |
| --- | --- |
| `d8cb0512` | Version bump to 3.5.21 — release system owns versions |
| Upstream README / `apps/cli/README.md` | Deferred to U2 branding |
| Full AsyncDbWriter drain/logging commits (`ba89fe28`, `921062eb`, `eb9817a6`) | Already present or orthogonal; no additional merge needed beyond collector `drain()` |

### U1 verification

| Step | Result |
| --- | --- |
| `bun run build` | ✅ pass (v3.5.20); CLI build no longer embeds post-processor worker |
| `bun run lint` | ✅ exit 0 (pre-existing warnings) |
| `bun run typecheck` | ✅ pass |
| `bun run format` | ✅ exit 0 — **note:** triggers pre-existing CRLF drift across ~500 files on Windows; restore unrelated paths before commit |
| `bun test` (full) | ⚠️ **1500 pass / 31 fail** — same pre-existing Windows baseline as U0 |
| `bun test` (`packages/proxy`) | ✅ **294 pass / 0 fail** |

---

## U2 — Rebrand to the-best-ccflare (2026-06-07)

### User-visible / metadata changes

| Surface | Change |
| --- | --- |
| Root `README.md` | Title, headings, fork attribution, clone/issues/releases URLs → `omcdowell/the-best-ccflare`; install/run commands keep npm package `better-ccflare` |
| `package.json` (root + `apps/cli`) | `repository` / `homepage` / `bugs` → fork; workspace/npm name unchanged |
| Dashboard | `PRODUCT_NAME` in nav, page title, API key dialog, overview subtitle via `@better-ccflare/ui-constants` branding module |
| `docs/` | Fork GitHub links and user-facing product name; technical env/header/path strings unchanged |

### Compatibility preserved (documented exceptions)

| Item | Kept as | Reason |
| --- | --- | --- |
| npm package / CLI binary | `better-ccflare` | Published package and command compatibility |
| Workspace scopes | `@better-ccflare/*` | Dependency graph unchanged |
| Env vars | `BETTER_CCFLARE_*`, `CCFLARE_*` | Existing deployments |
| HTTP headers | `x-better-ccflare-*` | Client/proxy contract |
| Config/data paths | `~/.config/better-ccflare/`, `better-ccflare.db` | Existing user data |
| Docker images | `ghcr.io/tombii/better-ccflare:*` | Upstream registry until fork publishes |
| `apps/cli/README.md` | Untouched | Scope guardrail |
| CLI `--version` / `--help` output | `better-ccflare` | Binary/command compatibility |

### U2 verification

| Step | Result |
| --- | --- |
| `bun test packages/ui-constants/src/branding.test.ts` | ✅ 4 pass |
| `bun run build` | ✅ pass (v3.5.20); dashboard + CLI binary built |
| `bun run lint` | ✅ exit 0 (201 pre-existing warnings); mass auto-fix reverted — not committed |
| `bun run typecheck` | ✅ pass |
| `bun run format` | ✅ exit 0; mass CRLF drift reverted — not committed |
| `bun test` (full) | ⚠️ **1504 pass / 31 fail** — same pre-existing Windows baseline as U0/U1 (no regressions) |

---

## U3 — Issue #5 route intent (2026-06-07)

### Staleness check (mandatory)

`git log origin/main --since='2026-06-04' --oneline --no-merges` on routing/selector paths:

```
7a18b843 feat: add native OpenAI and Anthropic provider routes with docs
e6418c75 feat: native Codex streaming passthrough and request observability
```

**Verdict:** Still applied — native prefixed routes landed but unprefixed `/v1/messages` did not exclude Codex on pool exhaustion.

### Implementation

| Change | Detail |
| --- | --- |
| `packages/proxy/src/routing/route-intent.ts` | Default exclude `codex` on `/v1/messages` and `/v1/messages/*`; opt-in via `x-better-ccflare-allow-providers: codex` |
| `account-selector.ts` | Uses `resolveRouteIntent(meta.path, meta.headers)` |
| Tests | `route-intent.test.ts`, account-selector, `route-intent-messages.test.ts` |
| Docs | README + `docs/api-http.md` |

### U3 verification

| Step | Result |
| --- | --- |
| `bun run build` | ✅ pass |
| `bun run lint` | ✅ exit 0 (201 pre-existing warnings); repo-wide `--write` reverted — do not commit mass CRLF drift |
| `bun run typecheck` | ✅ pass |
| `bun run format` | ✅ pass on U3 scope |
| `bun test packages/proxy` | ✅ **304 pass / 0 fail** |
| `bun test` (full) | ⚠️ **1514 pass / 31 fail** — same pre-existing Windows baseline as U0/U1/U2 (+9 new route-intent tests); **no regressions** |

---

## Assumptions & for-Oliver review

- **U0:** `upstream` remote added (fetch-only); merge performed in U1 via deliberate port (not fast-forward).
- **U0/U1:** Baseline lint/format mass-auto-fix is pre-existing repo drift on Windows; do not commit wholesale biome reformat — stage U1 files explicitly.
- **U0/U1:** 31 failing tests treated as pre-existing Windows baseline (1500 pass); CI (Linux) may be green — verify in U8 if needed.
- **U2:** Branding split — user-facing **the-best-ccflare** vs compatibility **better-ccflare** (npm/bin/paths/headers). Upstream Docker registry left on `tombii/better-ccflare` until fork publishes images.
