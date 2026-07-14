# CLAUDE.md

Load balancer proxy for Claude distributing requests across multiple account providers to avoid rate limiting.

## ⚠️ CRITICAL: Testing Restrictions

**NEVER curl the Anthropic endpoint** — not directly, and not via the proxy using the `claude` account. Real Anthropic accounts can get banned for automated/scripted usage. The `claude` account must only be used through real Claude Code. For testing, always use non-Anthropic accounts (ollama, litellm, omniroute, etc.) and force-route with `x-better-ccflare-account-id`.

## ⚠️ CRITICAL: File Exclusions

**README files** - Only modify `./README.md` (root). Do NOT modify `apps/cli/README.md`.

**NEVER TOUCH these auto-generated files** — must be excluded from all reads, edits, searches, and commits:
- `packages/proxy/src/inline-worker.ts`
- `packages/database/src/inline-vacuum-worker.ts`
- `packages/database/src/inline-integrity-check-worker.ts`

If accidentally modified: `git checkout -- <path>`

## Git Refspecs
This repo has both a `main` branch and a `main` tag. **Always use `refs/heads/main`** (not `main`) for local branch operations (push, checkout). For merge-base and log comparisons against the remote, use `origin/main` (the remote ref) to avoid the ambiguous refspec warning from the local tag.

## Branch Management
Always branch from `main` with a fresh pull. Never make changes directly on main.
PRs: `gh pr checkout <PR_NUMBER>` or `git checkout <branch-name>`.
- If `git push origin main` fails with `src refspec main matches more than one` (branch/tag name collision), push explicitly: `git push origin refs/heads/main:refs/heads/main`.

## PR Review Against Current Main (MANDATORY)

Before reviewing or merging any PR, always find the merge base and identify what main has added since the PR branched:

```bash
git fetch origin pull/<PR_NUMBER>/head:<branch-name>
git fetch origin main
MERGE_BASE=$(git merge-base <branch-name> origin/main)
git log $MERGE_BASE..origin/main --oneline          # commits on main the PR doesn't have
git diff $MERGE_BASE..origin/main --name-only        # files main changed since PR branched
```

Cross-check the PR's changed files against main's post-branch files. If they overlap, inspect those specific hunks to confirm the PR doesn't regress recent fixes. A PR based on an old main can silently overwrite hotfixes, security patches, or behaviour changes that landed after it branched.

## Merging PRs from External Contributors
When merging PRs from external contributors (not tombii), **create a merge commit** instead of squashing or rebasing. This preserves the contributor's commit history and ensures they appear in the git log as a contributor. Use:
```bash
git merge --no-ff <branch-name>
```
The `--no-ff` flag creates a merge commit even if the branch could be fast-forwarded.

**Do NOT use `gh pr merge`** — it may squash or rebase, losing the contributor's identity. Always merge manually with `git merge --no-ff`.

If the PR branch isn't available locally, fetch it first:
```bash
git fetch origin pull/<PR_NUMBER>/head:<branch-name>
git merge --no-ff <branch-name>
```

After merging, update the Acknowledgements section in README.md to thank the contributor for their specific contributions.

## Issue Management
- Never close issues automatically
- Wait for the issue reporter to confirm that fixes work for them before closing

## Issue Staleness Check (MANDATORY before implementing)
Before implementing any GitHub issue, always run:
```bash
git log origin/main --since='<issue-open-date>' --oneline --no-merges -- <relevant-paths>
```
Check if recent commits already partially or fully address the issue. Rate limiting, health, and proxy code change frequently. Ask the user "does this issue still apply given recent changes?" before proceeding. Especially check: has the reported symptom been fixed? Does the proposal conflict with new architecture?

## Database
- Default: `~/.config/better-ccflare/better-ccflare.db`
- Custom: Set `BETTER_CCFLARE_DB_PATH=/path/to/dev.db` in env or .env
- Query: `sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT name, provider, custom_endpoint FROM accounts;"`

## ⚠️ CRITICAL: Database Migrations — Port to PostgreSQL

**Every migration added to `packages/database/src/migrations.ts` MUST also be ported to `packages/database/src/migrations-pg.ts`.**

When adding a new column or table to SQLite:
1. Add it to `ensureSchema()` in `migrations.ts` (SQLite CREATE TABLE)
2. Add it to `runMigrations()` in `migrations.ts` (SQLite ALTER TABLE for existing DBs)
3. Add it to `ensureSchemaPg()` in `migrations-pg.ts` (PG CREATE TABLE for new installs)
4. Add an entry to the `columnsToAdd` array in `runMigrationsPg()` in `migrations-pg.ts` (PG ALTER TABLE for existing DBs)
5. If there's a backfill/data migration in SQLite, add the equivalent `adapter.unsafe(UPDATE ...)` call in `runMigrationsPg()` as well.

New tables also need to be created in `ensureSchemaPg()` AND in `runMigrationsPg()` (using `CREATE TABLE IF NOT EXISTS` so upgrades work).

## Subagents for Multi-Task Work
When a session involves multiple independent tasks, always spawn subagents rather than doing them sequentially in the main context. This conserves tokens and keeps the main context clean. Tasks don't need to run in parallel — the goal is context isolation, not speed.

**Default to subagents for any task that can be handed off:** code changes, research, code review, test runs, exploration, impact analysis, and any work that doesn't require direct interaction with the user mid-task. Only work inline in the main session for short, one-off responses or when you need to ask the user something before proceeding.

## Plan Execution
When executing implementation plans, always use subagent-driven development (superpowers:subagent-driven-development). Never execute plans inline in the main session. Always dispatch a fresh subagent per task.

## Test-Driven Development
When creating new functionality: write tests first, then implement, then run tests. This ensures the implementation matches the specs/request before and after coding.

## After Code Changes
Always run: `bun run lint && bun run typecheck && bun run format`

The GitNexus index refreshes automatically via a local git post-commit hook (`.git/hooks/post-commit`, runs `node .gitnexus/run.cjs analyze` detached). Do NOT run `gitnexus analyze` manually after commits — ignore "index is stale" reminders that appear right after committing; the background refresh is already running. Only run `node .gitnexus/run.cjs analyze` manually if the index stays stale long after the last commit (the hook may be missing on this machine — recreate it if so).

## Git Commits
- **Before making any changes, run `git status` to check for pre-existing uncommitted changes.** Note which files were already modified so you can distinguish your changes from theirs throughout the session.
- Use `git add <specific-files>` (not `git add .`) to avoid committing inline-worker.ts
- Check `git status` before committing

## Publishing to npm
- Use `cd apps/cli && bun publish` (avoids workspace errors)
- When pushing to git (triggers auto-publish), show complete output including npmjs.com auth URL: `https://www.npmjs.com/auth/cli/[uuid]`
- **NEVER bump the version** — version bumps are handled automatically by the release system

## Version Updates
**NEVER bump the version** — handled automatically by the release system.
`CLAUDE_CLI_VERSION` in `packages/core/src/version.ts` tracks Claude Code CLI version (auto-updated by pre-push hook).
If ever needed manually: update both `package.json` (root) and `apps/cli/package.json`.

## Commands

### Server
- First run: `bun run build` (builds dashboard/CLI)
- Start: `bun start` (port 8080) or `bun start --serve --port 8081` (testing)
- Startup: Takes ~15 seconds, wait before testing with curl
- Production: runs on port 8082. Test local changes on port 8081.

### Account Management
- Add: `bun run cli --add-account <name> --mode <claude-oauth|console|zai|minimax|anthropic-compatible|openai-compatible> --priority <number>`
- List: `bun run cli --list`
- Remove: `bun run cli --remove <name>`
- Reauth: `bun run cli --reauthenticate <name>` (preserves metadata, auto-notifies servers)
- Priority: `bun run cli --set-priority <name> <priority>` (lower = higher priority, 0 = first)
- Provider behavior: OAuth (5hr windows, session-based), API keys (pay-as-you-go, no sessions)

### Maintenance
- `bun run cli --reset-stats|--clear-history|--stats|--analyze`

### API Endpoints
- `POST /api/accounts/:id/reload|pause|resume`

### Testing OpenRouter
Always use model `z-ai/glm-4.5-air:free`:
```bash
curl -X POST http://localhost:8081/v1/messages -H "Content-Type: application/json" -H "Authorization: Bearer test" -d '{"model":"z-ai/glm-4.5-air:free","messages":[{"role":"user","content":"test"}],"max_tokens":10}'
```

## Environment
- OS timezone is UTC+2. Timestamps in logs and `/tmp` files are UTC — add 2 hours for local time.

## Qwen Provider
- When working on the Qwen provider or streaming transform, **always mirror the qwen-code implementation** at `/home/tom/git_repos/qwen-code/`. Check how qwen-code handles the same scenario before implementing.
- Qwen/DashScope sends incremental tool call argument chunks (not cumulative like standard OpenAI). The streaming transform buffers all chunks and emits complete JSON at stream end, matching `StreamingToolCallParser` in qwen-code.

## Commit Message Categories
Automated release system uses commit prefixes for changelog:
- Features: `feat:|add:|new:`
- Fixes: `fix:|bug:|resolve:`
- Security: `security:|vulnerabilit:|redact:|ReDoS:`
- Improvements: `improve:|enhance:|update:|refactor:`

**Acknowledgement commits** (when merging external PRs): always use `chore: acknowledge <name> for PR #<N>` as the commit subject. This prefix is excluded from release notes. If the merge also includes real fixes, commit them separately with the appropriate prefix.

## ⚠️ GitNexus Token Discipline: route ALL GitNexus calls through the `gitnexus-analyst` subagent

This section OVERRIDES the auto-generated GitNexus section below (everything between the `gitnexus:start`/`gitnexus:end` markers — do not edit inside those markers, `gitnexus analyze` regenerates them).

GitNexus MCP results are large and stay in the main context for the whole session. **Never call GitNexus MCP tools (`impact`, `context`, `query`, `detect_changes`, `cypher`, `rename`, etc.) directly in the main session.** Wherever the section below says to run a GitNexus tool, instead dispatch the `gitnexus-analyst` agent (`.claude/agents/gitnexus-analyst.md`, runs on haiku) with a description of what you need; it returns a ~30-line summary (risk level, d=1 callers, affected processes, HIGH/CRITICAL warnings) and the raw payloads stay in its throwaway context.

Fallback (only if the subagent is unavailable): call the tools inline but minimize payloads — `impact({summaryOnly: true})`, `query({limit: 3, max_symbols: 5})`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **better-ccflare** (7214 symbols, 16700 relationships, 259 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/better-ccflare/context` | Codebase overview, check index freshness |
| `gitnexus://repo/better-ccflare/clusters` | All functional areas |
| `gitnexus://repo/better-ccflare/processes` | All execution flows |
| `gitnexus://repo/better-ccflare/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
