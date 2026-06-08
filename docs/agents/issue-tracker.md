# Agent Issue Tracker

Work for this repo is tracked in GitHub Issues on `omcdowell/the-best-ccflare`.

- Repo: https://github.com/omcdowell/the-best-ccflare
- Use `gh issue view <number> --repo omcdowell/the-best-ccflare` before implementing an issue.
- Use `gh issue list --repo omcdowell/the-best-ccflare --state open` to find active work.
- Never close issues automatically; wait for the reporter/maintainer to confirm the fix.
- Before implementation, run the staleness check from `CLAUDE.md` against `origin/main` and relevant paths.
- For upstream context, also check `tombii/better-ccflare` issues/PRs when the local issue touches shared proxy, request-history, auth, routing, rate-limit, or persistence behavior.

## Current local issue context

As of 2026-06-08:

- `#5` — Prevent Claude traffic from unexpectedly falling back to Codex accounts.
- `#6` — Request History can show live SSE rows not yet persisted.
- `#7` — Codex request history rows miss model/token/cost/throughput fields.

Relevant local branches:

- `fix/issue-6-request-history-persistence` — focused fix for issue `#6`.
- `autonomous/overnight-catchup-feature-parity-branding-stale-payloads` — broad catch-up branch with route-intent, request persistence reconciliation, Codex usage summaries, stale-token retry, payload compression, upstream UsageCollector changes, and rebrand work.
