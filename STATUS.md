# Autonomous Run Status — the-best-ccflare

Last updated: 2026-06-07 00:00 UTC

Worktree: `D:\source\the-best-ccflare-autonomous-run`  
Branch: `autonomous/overnight-catchup-feature-parity-branding-stale-payloads`

## Queue

| Unit | Item | Status | Notes |
| --- | --- | --- | --- |
| U0 | Baseline clean worktree, open issues, staleness checks, upstream comparison, safe second-instance test harness | ⬜ todo | Create `HANDOFF.md` placeholder; record pre-existing baseline failures if any. |
| U1 | Catch up with upstream `better-ccflare` while preserving fork behavior | ⬜ todo | Fetch/compare upstream; merge/cherry-pick or record skipped deltas. |
| U2 | Rebrand visible/package/docs surface to `the-best-ccflare` | ⬜ todo | Root README only; never edit `apps/cli/README.md`; no version bump. |
| U3 | Issue #5: explicit route intent; no surprise Claude-to-Codex fallback | ⬜ todo | `/v1/messages` excludes Codex by default; Codex-prefixed routes still work. |
| U4 | Codex-native path feature parity with old Claude pathing, including issue #7 fields | ⬜ todo | Model/tokens/cost/throughput and observability parity where data exists. |
| U5 | Stale request error recovery with randomized auto-refresh | ⬜ todo | Bounded jitter/backoff; no real Anthropic calls in tests. |
| U6 | Persist compressed full message payloads for later analytics | ⬜ todo | SQLite and PostgreSQL migrations; compression/security conventions; list endpoints stay lean. |
| U7 | Issue #6: persisted/live request history reconciliation | ⬜ todo | Persist-before-final-SSE or pending/reconcile behavior. |
| U8 | Integration smoke, docs, handoff, final verification, push branch | ⬜ todo | Use a second instance only; never touch live port 8080. |
| Owner | Provide/rotate real OAuth/API credentials if needed for manual smoke | 🔒 owner-only | `claude -p` smoke tests are allowed/preferred when pointed at a second test instance; never raw-curl Anthropic or use live port 8080. |
| Owner | Approve production rollout/restart of live port 8080 instance | 🔒 owner-only | Run must not restart or test against live 8080. |
| Owner | Review, merge, publish, and confirm/close GitHub issues | 🔒 owner-only | Run pushes branch only; no merge/publish/issue closure. |

## Assumptions & for-Oliver review

