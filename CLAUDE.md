# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

A load balancer proxy for Claude and Claude Code that distributes requests across multiple OAuth accounts to avoid rate limiting.

## Important: Dashboard vs TUI

Unless specifically mentioned as "TUI", when referring to "dashboard" or "analytics", I mean the **web dashboard** (the React-based web UI), not the terminal-based TUI interface.

## Database Location

The production database is located at:
- `/home/tom/.config/better-ccflare/better-ccflare.db`

You can query it directly:
```bash
sqlite3 /home/tom/.config/better-ccflare/better-ccflare.db "SELECT name, provider, custom_endpoint FROM accounts;"
```

## Important: After making code changes

Always run:
- `bun run lint` - Fix linting issues
- `bun run typecheck` - Check for type errors
- `bun run format` - Format code

## Publishing to npm

When publishing the package to npm, always use bun (not npm):

```bash
cd apps/tui
bun publish
```

Using bun avoids workspace dependency errors that occur with npm commands. The package is pre-compiled into a binary, so users can install it with either npm or bun.

**IMPORTANT**: When pushing to git (which triggers automatic build and publish via pre-push hook), ALWAYS show the complete output including the npmjs.com authentication URL. The URL looks like:
```
https://www.npmjs.com/auth/cli/[uuid]
```

To ensure you see this URL, when running `git push`, do NOT limit the output. Always show all lines from the background process.

## Commands

### Running the server
- `bun start` - Start the load balancer (port 8080)
- **For testing**: Use port 8081 to avoid conflicts: `bun start --serve --port 8081`
- **Important**: The application takes ~15 seconds to start. When testing with curl, always wait at least 15 seconds after starting the server before making requests.

### Important: Production Server Management
The production server runs as a systemd service using the npm version, not the local code. When testing code changes:

1. **DO NOT use `sudo systemctl restart better-ccflare`** - this will restart the npm version, not your local changes
2. **DO use a different port** to test your local code: `bun start --serve --port 8081`
3. The systemd service uses the published npm package, so local code changes require running on a different port

### Managing accounts
- `better-ccflare --add-account <name>` - Add a new account
- `better-ccflare --list` - List all accounts
- `better-ccflare --remove <name>` - Remove an account
- `better-ccflare --set-priority <name> <priority>` - Set account priority

#### Account Priority System
**Important**: Lower priority numbers are tried first (0 = highest priority). The load balancer will attempt accounts in ascending order of priority number.
- Priority 0: Tried first
- Priority 5: Tried second
- Priority 10: Tried third
- etc.

Use `better-ccflare --list` to see current priorities and adjust accordingly.

### Testing OpenRouter Configuration
When testing OpenRouter accounts, use the following models to verify functionality:
- For mapping to `z-ai/glm-4.5-air:free`: Use model `claude-3-haiku-20240307`
- For direct model testing: Use model `z-ai/glm-4.5-air:free` directly

Example curl command:
```bash
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}'
```

### Maintenance
- `better-ccflare --reset-stats` - Reset usage statistics
- `better-ccflare --clear-history` - Clear request history