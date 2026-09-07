# Documentation

This directory contains detailed documentation for better-ccflare features and implementations.

## Available Documentation

### [OAuth Re-authentication Feature](oauth-reauthentication.md)
Comprehensive documentation of the OAuth re-authentication system that allows users to refresh expired tokens without losing account metadata.

**Topics covered:**
- Architecture and implementation details
- Security considerations
- API integration
- Usage examples
- Troubleshooting guide

### [Token Usage Report](token-usage-report.md)
How to compare token consumption across days or weeks and find what caused a
jump, using `scripts/token-usage-report.ts` against local Claude Code
transcripts — the history the retention-pruned `requests` table cannot provide.

**Topics covered:**
- Why the proxy database cannot answer week-over-week questions
- Running the report and reading its columns
- Attributing a period to models, projects or subagent types
- Limits of transcript-based accounting

## For Developers

These documents provide in-depth technical details for developers working on the better-ccflare codebase. For user-facing documentation, see the main [CLAUDE.md](../CLAUDE.md) file.