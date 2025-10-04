# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

A load balancer proxy for Claude and Claude Code that distributes requests across multiple OAuth accounts to avoid rate limiting.

## Important: Dashboard vs TUI

Unless specifically mentioned as "TUI", when referring to "dashboard" or "analytics", I mean the **web dashboard** (the React-based web UI), not the terminal-based TUI interface.

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

## Commands

### Running the server
- `bun start` - Start the load balancer (port 8080)
- **For testing**: Use port 8081 to avoid conflicts: `better-ccflare --serve --port 8081`

### Important: Production Server Management
The production server runs as a systemd service using the npm version, not the local code. When testing code changes:

1. **DO NOT use `sudo systemctl restart better-ccflare`** - this will restart the npm version, not your local changes
2. **DO use a different port** to test your local code: `better-ccflare --serve --port 8081`
3. The systemd service uses the published npm package, so local code changes require running on a different port

### Managing accounts
- `better-ccflare --add-account <name>` - Add a new account
- `better-ccflare --list` - List all accounts
- `better-ccflare --remove <name>` - Remove an account

### Maintenance
- `better-ccflare --reset-stats` - Reset usage statistics
- `better-ccflare --clear-history` - Clear request history