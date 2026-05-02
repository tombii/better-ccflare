# CLAUDE.md

Load balancer proxy for Claude distributing requests across multiple account providers to avoid rate limiting.

## ⚠️ CRITICAL: Testing Restrictions

**NEVER curl the Anthropic endpoint** — not directly, and not via the proxy using the `claude` account. Real Anthropic accounts can get banned for automated/scripted usage. The `claude` account must only be used through real Claude Code. For testing, always use non-Anthropic accounts (ollama, litellm, omniroute, etc.) and force-route with `x-better-ccflare-account-id`.

## ⚠️ CRITICAL: File Exclusions

**README files** - Only modify `./README.md` (root). Do NOT modify `apps/cli/README.md`.

**NEVER TOUCH `inline-worker.ts`** — auto-generated, must be excluded from all reads, edits, searches, and commits.
If accidentally modified: `git checkout -- packages/proxy/src/inline-worker.ts`

## Git Refspecs
This repo has both a `main` branch and a `main` tag. **Always use `refs/heads/main`** (not `main`) for all git log, diff, checkout, and merge-base commands to avoid ambiguous refspec errors. Applies to: `git log refs/heads/main`, `git diff refs/heads/main...`, `git merge-base refs/heads/main`, etc.

## Branch Management
Always branch from `main` with a fresh pull. Never make changes directly on main.
PRs: `gh pr checkout <PR_NUMBER>` or `git checkout <branch-name>`.
- If `git push origin main` fails with `src refspec main matches more than one` (branch/tag name collision), push explicitly: `git push origin refs/heads/main:refs/heads/main`.

## Issue Management
- Never close issues automatically
- Wait for the issue reporter to confirm that fixes work for them before closing

## Database
- Default: `~/.config/better-ccflare/better-ccflare.db`
- Custom: Set `BETTER_CCFLARE_DB_PATH=/path/to/dev.db` in env or .env
- Query: `sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT name, provider, custom_endpoint FROM accounts;"`

## Subagents for Multi-Task Work
When a session involves multiple independent tasks, always spawn subagents rather than doing them sequentially in the main context. This conserves tokens and keeps the main context clean. Tasks don't need to run in parallel — the goal is context isolation, not speed.

**Default to subagents for any task that can be handed off:** code changes, research, code review, test runs, exploration, impact analysis, and any work that doesn't require direct interaction with the user mid-task. Only work inline in the main session for short, one-off responses or when you need to ask the user something before proceeding.

## Plan Execution
When executing implementation plans, always use subagent-driven development (superpowers:subagent-driven-development). Never execute plans inline in the main session. Always dispatch a fresh subagent per task.

## Test-Driven Development
When creating new functionality: write tests first, then implement, then run tests.

## After Code Changes
Always run: `bun run lint && bun run typecheck && bun run format`

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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **better-ccflare** (8631 symbols, 15334 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

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
