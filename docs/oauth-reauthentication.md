# OAuth Re-authentication Feature

## Overview

The OAuth re-authentication feature allows users to refresh expired OAuth tokens for their accounts while preserving all existing account metadata, including usage statistics, priority settings, and request history. This solves the problem of token expiration without requiring users to delete and recreate accounts, which would result in loss of valuable data.

## Problem Statement

Previously, when OAuth tokens expired, users had to:
1. Delete the expired account
2. Add a new account with the same name
3. Lose all usage statistics, priority settings, and request history

The re-authentication feature provides a "soft re-authentication" that updates only the OAuth tokens while preserving all other account data.

## Implementation Details

### CLI Interface

The feature is accessible via the CLI command:

```bash
bun run cli --reauthenticate <account-name>
```

### Architecture

The implementation consists of several coordinated components:

#### 1. CLI Command Handler (`packages/cli-commands/src/commands/account.ts`)

- **Function**: `reauthenticateAccount()` (lines 551-764)
- **Purpose**: Main orchestrator that handles the re-authentication flow
- **Key Responsibilities**:
  - Retrieve existing account from database
  - Determine account mode (OAuth vs Console) based on token presence
  - Generate OAuth authorization URL
  - Handle token exchange
  - Update database with new tokens
  - Trigger server reload

#### 2. OAuth Flow Modifications (`packages/oauth-flow/src/index.ts`)

- **Modification**: Added `skipAccountCheck` parameter to `BeginOptions` interface
- **Purpose**: Allow re-authentication without throwing "account already exists" errors
- **Key Code**:
```typescript
export interface BeginOptions {
    name: string;
    mode: "max" | "console";
    skipAccountCheck?: boolean; // Skip account existence check for re-authentication
}
```

#### 3. Provider-Specific URL Generation (`packages/providers/src/providers/anthropic/oauth.ts`)

- **Function**: `generateAuthUrl()`
- **Purpose**: Generate correct OAuth URLs for different account types
- **Key Logic**:
  - Claude CLI (max mode): Uses `claude.ai/login` with returnTo parameter
  - Console mode: Uses direct OAuth flow

#### 4. Token Manager Cache Management (`packages/proxy/src/handlers/token-manager.ts`)

- **Functions**:
  - `registerRefreshClearer()`: Register server's cache clearing function
  - `clearAccountRefreshCache()`: Clear refresh cache across all running servers
- **Purpose**: Ensure new tokens are used immediately after re-authentication

#### 5. API Endpoint (`packages/http-api/src/handlers/accounts.ts`)

- **Function**: `createAccountReloadHandler()` (lines 1199-1239)
- **Endpoint**: `POST /api/accounts/:id/reload`
- **Purpose**: Trigger token reload for specific account

#### 6. Server Integration (`apps/server/src/server.ts`)

- **Registration**: Server registers its cache clearing function on startup
- **Purpose**: Allow external processes to trigger token cache clearing

### Database Schema

The re-authentication feature updates the following fields in the `accounts` table:

- `access_token`: New OAuth access token
- `refresh_token`: New OAuth refresh token
- `expires_at`: New token expiration timestamp
- `token_type`: Token type (typically "Bearer")
- `scope`: OAuth scope (typically "all")

All other fields remain unchanged:
- `name`: Account name
- `provider`: Provider type
- `priority`: Priority settings
- `custom_endpoint`: Custom endpoint configuration
- `usage_statistics`: Usage metrics
- `request_history`: Request logs

### Security Considerations

1. **Token Validation**: The feature validates the token exchange before updating the database
2. **PKCE Flow**: Uses Proof Key for Code Exchange (PKCE) for security
3. **State Parameter**: Uses OAuth state parameter to prevent CSRF attacks
4. **Database Transactions**: Ensures atomic updates to prevent inconsistent states

### Error Handling

The implementation includes comprehensive error handling:

1. **Account Not Found**: Clear error message if account doesn't exist
2. **OAuth Flow Errors**: Graceful handling of OAuth failures
3. **Database Errors**: Transaction rollback on database failures
4. **Server Communication**: Best-effort notification to running servers

## Usage Examples

### Basic Re-authentication

```bash
# Re-authenticate an account named "claude"
bun run cli --reauthenticate claude
```

### Example Output

```bash
# For Claude CLI (OAuth) account
bun run cli --reauthenticate claude
> Re-authenticating account: claude
> Opening browser for OAuth authorization...
> Account 'claude' has been successfully re-authenticated
> Token cache has been cleared for running servers
```

## API Integration

### Server Reload Endpoint

**Endpoint**: `POST /api/accounts/:id/reload`

**Purpose**: Trigger token reload for a specific account

**Response**:
```json
{
  "success": true,
  "message": "Token reload triggered for account 'claude'"
}
```

### Server Cache Clearing

Running servers automatically register their cache clearing functions. When re-authentication completes, the system:

1. Calls `clearAccountRefreshCache(accountId)` for all registered servers
2. Servers clear their in-memory token cache for the specified account
3. New tokens are used on subsequent requests

## Implementation Timeline

1. **Initial Implementation**: Core re-authentication CLI command
2. **OAuth Flow Enhancement**: Added support for re-authentication without duplicate account errors
3. **URL Format Fix**: Corrected OAuth URL generation for different account types
4. **Server Integration**: Added automatic token cache clearing
5. **Documentation**: Comprehensive documentation and API integration

## Testing

### Manual Testing Steps

1. **Setup**: Add an OAuth account and let tokens expire
2. **Re-authentication**: Run `bun run cli --reauthenticate <account-name>`
3. **Verification**: Check that tokens are updated in database
4. **Cache Testing**: Verify that running servers use new tokens immediately
5. **Data Preservation**: Confirm that usage stats and priorities are preserved

### Database Verification

```sql
-- Check token updates
SELECT name, access_token, refresh_token, expires_at
FROM accounts
WHERE name = 'claude';

-- Verify metadata preservation
SELECT name, priority, usage_statistics
FROM accounts
WHERE name = 'claude';
```

## Future Enhancements

Potential improvements to consider:

1. **Automatic Token Refresh**: Background process to refresh tokens before expiration
2. **Bulk Re-authentication**: Re-authenticate multiple accounts simultaneously
3. **Token Health Monitoring**: Proactive monitoring of token expiration
4. **Web Dashboard Integration**: Trigger re-authentication from web interface

## Troubleshooting

### Common Issues

1. **Browser Not Opening**: Manual URL copy-paste required
2. **OAuth Errors**: Verify account mode and URL format
3. **Stale Tokens After Server Restart**: Fixed in v2.0.11+ - the server now automatically syncs fresh DB tokens to in-memory account objects during usage polling
4. **Database Locks**: Ensure no other processes are modifying account data

### Debug Information

Enable debug logging by setting environment variable:

```bash
DEBUG=oauth:* bun run cli --reauthenticate claude
```

## Security Notes

- Re-authentication uses the same secure OAuth flow as initial account setup
- Tokens are stored encrypted in the database
- No sensitive information is logged during the re-authentication process
- State parameters prevent CSRF attacks during OAuth flow