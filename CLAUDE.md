# CLAUDE.md

Load balancer proxy for Claude distributing requests across multiple account providers to avoid rate limiting.

## ⚠️ CRITICAL: File Exclusions

**README files** - Only modify `./README.md` (root). Do NOT modify `apps/cli/README.md`.

**NEVER TOUCH `inline-worker.ts`** - This file is auto-generated during build and MUST be completely ignored:
- ❌ Do NOT read it
- ❌ Do NOT edit it
- ❌ Do NOT stage/commit it (`git add`)
- ❌ Do NOT reference it in any tool calls
- ❌ Do NOT include it in search results
- ❌ If accidentally modified, revert it immediately with `git checkout -- packages/proxy/src/inline-worker.ts`

When using glob patterns or file searches, explicitly exclude this file.

## Branch Management
- Feature branches: Create from `main`. Pull latest first: `git checkout main && git pull origin main && git checkout -b feature/name`
- Hotfixes: Create from `main`. Pull latest first: `git checkout main && git pull origin main && git checkout -b hotfix/name`
- PRs: Use `gh pr checkout <PR_NUMBER>` or `git checkout <branch-name>`. Never make PR changes on main.

## Issue Management
- Never close issues automatically
- Wait for the issue reporter to confirm that fixes work for them before closing

## Database
- Default: `~/.config/better-ccflare/better-ccflare.db`
- Custom: Set `BETTER_CCFLARE_DB_PATH=/path/to/dev.db` in env or .env
- Query: `sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT name, provider, custom_endpoint FROM accounts;"`

## After Code Changes
Always run: `bun run lint && bun run typecheck && bun run format`

## Git Commits
- Use `git add <specific-files>` (not `git add .`) to avoid committing inline-worker.ts
- Check `git status` before committing

## Publishing to npm
- Use `cd apps/cli && bun publish` (avoids workspace errors)
- When pushing to git (triggers auto-publish), show complete output including npmjs.com auth URL: `https://www.npmjs.com/auth/cli/[uuid]`
- Skip version bump: Add `[skip-version]` or `[no-version]` to commit message

## Version Updates
When bumping better-ccflare version, update in both files:
- `package.json` (root)
- `apps/cli/package.json`

Note: `CLAUDE_CLI_VERSION` in `packages/core/src/version.ts` tracks the official Claude Code CLI version and is auto-updated by the pre-push hook from npm registry.

## Commands

### Server
- First run: `bun run build` (builds dashboard/CLI)
- Start: `bun start` (port 8080) or `bun start --serve --port 8081` (testing)
- Startup: Takes ~15 seconds, wait before testing with curl
- Production: systemd service uses npm version. Test local changes on port 8081, NOT via `systemctl restart`

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

## Commit Message Categories
Automated release system uses commit prefixes for changelog:
- Features: `feat:|add:|new:`
- Fixes: `fix:|bug:|resolve:`
- Security: `security:|vulnerabilit:|redact:|ReDoS:`
- Improvements: `improve:|enhance:|update:|refactor:`