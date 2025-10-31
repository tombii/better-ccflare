# Migration Guide: Version 2 to Version 3

This guide covers the important changes and migration steps when upgrading from better-ccflare version 2.x to version 3.x.

## Overview

Version 3.0 introduces significant improvements to provider management, session handling, and overall architecture. The main changes focus on better separation between different provider types and more robust session management.

## Breaking Changes

### 1. Provider Type Separation

**Before (v2.x):**
- All Anthropic-related accounts used the same `anthropic` provider type
- Both OAuth and Console API accounts were treated as the same provider

**After (v3.x):**
- `anthropic` - Claude OAuth accounts with 5-hour usage windows
- `claude-console-api` - Claude API key accounts with pay-as-you-go model
- Other providers remain unchanged

### 2. Session Behavior Changes

**Before (v2.x):**
- All providers (including API-key-based) had 5-hour session windows
- This was inappropriate for pay-as-you-go providers

**After (v3.x):**
- Only Anthropic OAuth accounts have 5-hour session windows
- All other providers (Zai, Minimax, OpenAI-compatible, Claude Console API) operate on pay-as-you-go basis with no session windows
- This provides better resource utilization for API-key-based providers

### 3. Auto-Fallback Enhancement

**Before (v2.x):**
- Auto-fallback was available for all account types
- Could cause issues with pay-as-you-go providers

**After (v3.x):**
- Auto-fallback is now only available for Anthropic OAuth accounts
- This aligns with Anthropic's 5-hour usage window system

## Automatic Migration

The system automatically migrates existing Claude Console API accounts during the first startup:

1. Accounts with `provider: "anthropic"` AND `api_key` field populated will be automatically updated to `provider: "claude-console-api"`
2. All other account settings remain unchanged
3. No manual intervention required

## Configuration Changes

### Environment Variables

No breaking changes to environment variables. All existing configuration options remain the same.

### API Changes

No breaking changes to the public API. All endpoints continue to work as before.

## Migration Process

### 1. Backup Your Database

Before upgrading, create a backup of your database:

```bash
cp ~/.config/better-ccflare/better-ccflare.db ~/.config/better-ccflare/better-ccflare.db.backup
```

### 2. Update to Version 3

```bash
# Using npm
npm update better-ccflare

# Using bun
bun update better-ccflare

# Or install fresh
npm install -g better-ccflare@latest
# or
bun install -g better-ccflare@latest
```

### 3. Start the Application

Start better-ccflare normally. The migration will run automatically:

```bash
better-ccflare
```

You should see log messages indicating the migration is running:

```
Updated X accounts from 'anthropic' to 'claude-console-api' provider (console accounts)
```

### 4. Verify Migration

Check that your accounts are properly configured:

```bash
# List all accounts to verify provider types
better-ccflare --list
```

## Provider-Specific Behavior

### Anthropic OAuth Accounts (`anthropic`)
- Continue to use 5-hour session windows
- Support auto-fallback when usage windows reset
- Maintain conversation context during sessions

### Claude Console API Accounts (`claude-console-api`)
- No session windows (pay-as-you-go)
- No auto-fallback (not applicable)
- Direct API key usage

### Other Providers (Zai, Minimax, OpenAI-compatible, etc.)
- No session windows (pay-as-you-go)
- No auto-fallback (not applicable)
- Direct API key usage

## Troubleshooting

### Issue: Accounts Not Migrating Properly
**Solution:** Check that your Claude Console API accounts have the `api_key` field populated in the database. If not, you may need to re-add these accounts.

### Issue: Unexpected Session Behavior
**Solution:** Verify that only Anthropic OAuth accounts have session behavior. Other providers should not have 5-hour session windows.

### Issue: Auto-Fallback Not Working
**Solution:** Auto-fallback only works for Anthropic OAuth accounts. It's expected behavior that other providers don't have auto-fallback.

## API Changes

The following internal changes were made but don't affect the public API:

- New provider-specific configuration system
- Enhanced type safety for provider operations
- Improved migration robustness with database transactions

## Support

If you encounter issues during migration:

1. Check the logs for error messages
2. Verify your database backup exists
3. Consult the [GitHub Issues](https://github.com/tombii/better-ccflare/issues) page
4. Create a new issue if needed with your version information and error details