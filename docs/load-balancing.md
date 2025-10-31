# Load Balancing in better-ccflare

## Table of Contents
1. [Overview](#overview)
2. [Session-Based Strategy](#session-based-strategy)
3. [Account Priorities](#account-priorities)
4. [Configuration](#configuration)
5. [Account Selection Process](#account-selection-process)
6. [Performance Considerations](#performance-considerations)
7. [Important: Why Only Session-Based Strategy](#important-why-only-session-based-strategy)

## Overview

better-ccflare implements a session-based load balancing system to distribute requests across multiple Claude CLI OAuth accounts, avoiding rate limits and ensuring high availability. The system maintains configurable sessions (default: 5 hours) with individual accounts to minimize rate limit issues.

### Key Features
- **Account Health Monitoring**: Automatically filters out rate-limited or paused accounts
- **Failover Support**: Returns ordered lists of accounts for automatic failover
- **Session Persistence**: Maintains configurable sessions on specific accounts
- **Account Priorities**: Supports prioritized account selection for better control over load distribution
- **Auto-Fallback**: Automatically switches back to higher priority accounts when their usage windows reset
- **Usage Window Alignment**: Sessions automatically align with Anthropic OAuth 5-hour usage window resets for optimal resource utilization
- **Real-time Configuration**: Change settings without restarting the server
- **Provider Filtering**: Accounts are filtered by provider compatibility

## Session-Based Strategy

**Description**: Maintains sticky sessions with individual accounts for a configurable duration (default: 5 hours). This is the only load balancing strategy available in better-ccflare, designed to minimize account switching and reduce the likelihood of hitting rate limits.

**Use Case**: Optimal for production environments where minimizing rate limits is crucial. Particularly effective for applications with sustained user sessions.

**Implementation Details**:
```typescript
export class SessionStrategy implements LoadBalancingStrategy {
    private sessionDurationMs: number;
    private store: StrategyStore | null = null;
    private log = new Logger("SessionStrategy");

    constructor(sessionDurationMs: number = TIME_CONSTANTS.SESSION_DURATION_DEFAULT) {
        this.sessionDurationMs = sessionDurationMs;
    }

    initialize(store: StrategyStore): void {
        this.store = store;
    }

    select(accounts: Account[], _meta: RequestMeta): Account[] {
        const now = Date.now();
        
        // Find account with most recent active session
        let activeAccount: Account | null = null;
        let mostRecentSessionStart = 0;
        
        for (const account of accounts) {
            if (account.session_start && 
                now - account.session_start < this.sessionDurationMs &&
                account.session_start > mostRecentSessionStart) {
                activeAccount = account;
                mostRecentSessionStart = account.session_start;
            }
        }
        
        // Use active account if available
        if (activeAccount && isAccountAvailable(activeAccount, now)) {
            const others = accounts.filter(
                a => a.id !== activeAccount.id && isAccountAvailable(a, now)
            );
            return [activeAccount, ...others]; // Active account first, others as fallback
        }
        
        // No active session - start new one with first available account
        const available = accounts.filter(a => isAccountAvailable(a, now));
        if (available.length === 0) return [];
        
        const chosenAccount = available[0];
        this.resetSessionIfExpired(chosenAccount);
        
        const others = available.filter(a => a.id !== chosenAccount.id);
        return [chosenAccount, ...others];
    }
}
```

**Characteristics**:
- ✅ **Excellent Rate Limit Avoidance**: Minimizes account switching
- ✅ **Predictable Behavior**: Consistent account usage patterns
- ✅ **Good for Long Sessions**: Ideal for extended AI conversations
- ⚠️ **Uneven Load Distribution**: May concentrate load on fewer accounts
- ⚠️ **Session Dependency**: Performance tied to specific account availability

## Usage Window Alignment for Anthropic OAuth

**Description**: For Anthropic OAuth accounts, the session strategy includes intelligent optimization that aligns session resets with the actual 5-hour usage windows provided by Anthropic's API, ensuring optimal resource utilization. Other providers (like API-key-based accounts) do not use fixed-duration session tracking and instead operate on a pay-as-you-go basis without session windows.

**How It Works**:

The system implements provider-specific session reset logic:

1. **Provider Check**: First determines if the account's provider requires session duration tracking (currently only Anthropic providers do)
2. **Fixed Duration Check**: For providers that require session duration tracking (like Anthropic), sessions reset after the configured duration (default: 5 hours)
3. **Usage Window Reset Check**: For Anthropic OAuth accounts only, sessions also reset when the API's usage window expires (based on `rate_limit_reset` timestamp)

```typescript
// Provider-specific session duration tracking
const requiresSessionTracking = requiresSessionDurationTracking(account.provider);

const fixedDurationExpired = requiresSessionTracking &&
    ( !account.session_start ||
    now - account.session_start >= this.sessionDurationMs );

const rateLimitWindowReset = !fixedDurationExpired &&
    account.provider === "anthropic" &&
    account.rate_limit_reset &&
    account.rate_limit_reset < now;

if (fixedDurationExpired || rateLimitWindowReset) {
    // Reset session for optimal resource utilization
    this.store.resetAccountSession(account.id, now);
}
```

**Benefits**:

- **Optimal Resource Utilization**: Sessions align perfectly with Anthropic's actual usage windows
- **Reduced Waste**: No premature session resets when usage windows are still active
- **Performance Optimized**: Rate limit checks only occur when needed (when fixed duration hasn't expired)

**Provider Compatibility**:

- ✅ **Anthropic OAuth**: Full usage window alignment support with 5-hour session tracking
- ✅ **Other Providers** (API-key-based, OpenAI-compatible, etc.): No fixed-duration session tracking - operate on pay-as-you-go basis
- ✅ **Mixed Environments**: Works seamlessly with accounts from different providers

**Race Condition Prevention**: The implementation uses strict `<` comparisons instead of `<=` to prevent race conditions where sessions might reset prematurely at the exact moment the usage window resets.

### Future Extensibility for API-Based Providers

**Current Implementation**: The usage window alignment is currently optimized for Anthropic OAuth accounts, which provide explicit `rate_limit_reset` timestamps via their API. Other providers (API-key-based, OpenAI-compatible, etc.) operate on a pay-as-you-go basis without fixed-duration session tracking.

**Current Extensible Architecture**: The system includes a provider-specific configuration system that allows easy extension for future providers with usage windows:

```typescript
// Current implementation in types/constants.ts
const PROVIDER_SESSION_TRACKING_CONFIG: Record<ProviderName, boolean> = {
    [PROVIDER_NAMES.ANTHROPIC]: true,   // Anthropic has 5-hour usage windows
    [PROVIDER_NAMES.ZAI]: false,        // Zai is typically pay-as-you-go
    [PROVIDER_NAMES.OPENAI_COMPATIBLE]: false, // OpenAI-compatible is typically pay-as-you-go
} as const;

// Function to check if a provider requires session duration tracking
export function requiresSessionDurationTracking(provider: string): boolean {
    const providerName = provider as ProviderName;
    if (providerName in PROVIDER_SESSION_TRACKING_CONFIG) {
        return PROVIDER_SESSION_TRACKING_CONFIG[providerName];
    }
    // For unknown providers, default to false (no session duration tracking)
    return false;
}
```

**Future Enhancement Path**: For API-based providers that implement their own usage windows (5-hour, daily, or custom intervals), you can simply update the configuration:

```typescript
// Example: Adding support for a new provider with usage windows
const PROVIDER_SESSION_TRACKING_CONFIG: Record<ProviderName, boolean> = {
    [PROVIDER_NAMES.ANTHROPIC]: true,           // Anthropic has 5-hour usage windows
    [PROVIDER_NAMES.ZAI]: false,                // Zai is typically pay-as-you-go
    [PROVIDER_NAMES.OPENAI_COMPATIBLE]: false,  // OpenAI-compatible is typically pay-as-you-go
    [PROVIDER_NAMES.NEW_PROVIDER]: true,        // New provider has usage windows
} as const;
```

**Implementation Benefits**:
1. **Simple Extension**: New providers can be added by updating the configuration
2. **Backward Compatibility**: Existing providers continue working as expected
3. **Provider-Specific Logic**: Each provider can have tailored session handling
4. **Future-Proof**: Ready for any new providers with usage window systems

## Account Priorities

Account priorities allow you to control which accounts are preferred when multiple accounts are available. This feature gives you fine-grained control over load distribution and account selection.

### How Priorities Work

- **Priority Range**: Accounts can have a priority value from 0-100 (default: 0)
- **Lower Value = Higher Priority**: Accounts with lower priority values are selected first
- **Optional Parameter**: Priority is optional when adding accounts and defaults to 0 (highest priority)
- **Affects Both Primary and Fallback Selection**: Priorities determine both the primary account and the order of fallback accounts
- **Real-time Updates**: Priority changes take effect immediately without restarting the server

### Setting Account Priorities

Priorities can be set when adding an account or updated later:

```bash
# Add account with priority
better-ccflare --add-account myaccount --mode claude-oauth --priority 10

# Update account priority
better-ccflare set-priority myaccount 20
```

### Priority in Load Balancing

The SessionStrategy considers priorities when selecting accounts:

1. **Active Session Check**: First looks for an account with an active session
2. **Priority Sorting**: If no active session or the active account is unavailable, available accounts are sorted by priority (descending)
3. **Fallback Order**: Remaining accounts are also ordered by priority for failover scenarios

```typescript
// From load-balancer/src/strategies/index.ts
// Filter available accounts and sort by priority (lower value = higher priority)
const available = accounts
    .filter((a) => isAccountAvailable(a, now))
    .sort((a, b) => a.priority - b.priority); // Ascending sort
```

### Use Cases for Priorities

1. **Primary/Backup Setup**: Assign higher priorities to preferred accounts
2. **Cost Management**: Prioritize free or lower-cost accounts
3. **Performance Optimization**: Prioritize accounts with better performance characteristics
4. **Tiered Access**: Create hierarchical access patterns based on account capabilities

## Auto-Fallback Feature

The auto-fallback feature provides intelligent automatic switching back to higher priority accounts when their usage windows reset, allowing you to automatically take advantage of preferred accounts as soon as they become available again.

### How Auto-Fallback Works

Auto-fallback operates at the account level and uses the API's rate limit reset information to determine when accounts become available:

1. **Anthropic Only**: Auto-fallback is only available for Anthropic accounts since only they provide rate limit reset information via the API
2. **Per-Account Setting**: Each Anthropic account can have auto-fallback enabled or disabled independently
3. **Priority-Based Selection**: When multiple accounts have auto-fallback enabled and become available, the system selects the one with the highest priority (lowest priority number)
4. **API Reset Detection**: Uses the `rate_limit_reset` timestamp from the Anthropic API to detect when usage windows have reset
5. **Automatic Switching**: Before processing each request, the system checks for higher priority accounts with auto-fallback enabled that have become available

### Auto-Fallback Logic

```typescript
// Simplified logic from load-balancer/src/strategies/index.ts
private checkForAutoFallbackAccounts(accounts: Account[], now: number): Account[] {
    const resetAccounts = accounts.filter((account) => {
        if (!account.auto_fallback_enabled) return false;
        if (account.paused) return false;

        // Check if the API usage window has reset
        const windowReset = account.rate_limit_reset && account.rate_limit_reset <= now;

        // Check if the account is not currently rate limited by our system
        const notRateLimited = !account.rate_limited_until || account.rate_limited_until <= now;

        return windowReset && notRateLimited;
    });

    // Sort by priority (lower number = higher priority)
    return resetAccounts.sort((a, b) => a.priority - b.priority);
}
```

### Enabling Auto-Fallback

Auto-fallback can be configured via the HTTP API:

```bash
# Enable auto-fallback for an account
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

# Disable auto-fallback for an account
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 0}'
```

### Auto-Fallback Behavior

1. **Request Processing**: Before each request, the strategy checks for auto-fallback candidates
2. **Priority Consideration**: Only considers accounts with higher priority than the current active account
3. **Session Reset**: When switching to an auto-fallback account, the session is reset for the new account
4. **Logging**: The system logs when auto-fallback is triggered for transparency

### Use Cases for Auto-Fallback

1. **Primary Account Recovery**: Automatically switch back to your main account as soon as its rate limit window resets
2. **Cost Optimization**: Prioritize lower-cost accounts when they become available
3. **Performance Preference**: Automatically use higher-performance accounts when they're ready
4. **Tiered Access Management**: Ensure priority accounts get used first when available

### Example Scenario

```
Initial State:
- Account A (priority: 0): Rate limited, auto-fallback enabled
- Account B (priority: 10): Currently being used
- Account C (priority: 20): Available as fallback

When Account A's usage window resets:
1. System detects Account A is available again (rate_limit_reset passed)
2. Auto-fallback triggers because Account A has higher priority and auto-fallback enabled
3. System switches to Account A for the next request
4. Log: "Auto-fallback triggered to account A (priority: 0, auto-fallback enabled)"
```

### Configuration

Auto-fallback is configured per-account via the API and stored in the database:

```sql
-- Database field
ALTER TABLE accounts ADD COLUMN auto_fallback_enabled INTEGER DEFAULT 0;
```

The setting defaults to `disabled` (0) for all existing accounts to maintain backward compatibility.

## Configuration

better-ccflare uses a hierarchical configuration system where environment variables take precedence over configuration file settings.

### Configuration Precedence (highest to lowest)
1. Environment variables
2. Configuration file (`~/.better-ccflare/config.json`)
3. Default values

### Environment Variables

```bash
# Load balancing strategy (only 'session' is supported)
LB_STRATEGY=session

# Session duration in milliseconds (default: 18000000ms = 5 hours)
SESSION_DURATION_MS=18000000

# Server port (default: 8080)
PORT=8080

# Client ID for OAuth (default: 9d1c250a-e61b-44d9-88ed-5944d1962f5e)
CLIENT_ID=your-client-id

# Retry configuration
RETRY_ATTEMPTS=3
RETRY_DELAY_MS=1000
RETRY_BACKOFF=2
```

### Configuration File

The configuration file is automatically created at `~/.better-ccflare/config.json` on first run:

```json
{
    "lb_strategy": "session",
    "session_duration_ms": 18000000,
    "port": 8080,
    "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    "retry_attempts": 3,
    "retry_delay_ms": 1000,
    "retry_backoff": 2
}
```

### Time Constants

The following time constants are used throughout the system:
- `SESSION_DURATION_DEFAULT`: 18000000ms (5 hours)
- `SESSION_DURATION_FALLBACK`: 3600000ms (1 hour) - used if configuration is invalid

### Dynamic Configuration

The strategy configuration can be changed at runtime via the HTTP API:

```bash
# Get current strategy
curl http://localhost:8080/api/config/strategy

# Update strategy (only 'session' is valid)
curl -X PUT http://localhost:8080/api/config/strategy \
  -H "Content-Type: application/json" \
  -d '{"strategy": "session"}'

# Get all configuration settings
curl http://localhost:8080/api/config

# Get available strategies
curl http://localhost:8080/api/config/strategies
```

## Account Selection Process

The load balancer follows a specific process when selecting accounts for requests:

### 1. Auto-Fallback Check (New)
Before checking for active sessions, the system first checks for auto-fallback candidates:
```typescript
// Check for higher priority accounts that have become available due to rate limit reset
const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
if (fallbackCandidates.length > 0) {
    // Use the highest priority auto-fallback account
    return [chosenFallback, ...otherAccounts];
}
```

### 2. Account Filtering
```typescript
// From proxy/handlers/account-selector.ts
const providerAccounts = allAccounts.filter(
    (account) => account.provider === ctx.provider.name || account.provider === null
);
```
- Accounts are first filtered by provider compatibility
- Only accounts matching the current provider or with null provider are considered

### 2. Availability Check
```typescript
// From core/strategy.ts
export function isAccountAvailable(account: Account, now = Date.now()): boolean {
    return (
        !account.paused &&
        (!account.rate_limited_until || account.rate_limited_until < now)
    );
}
```
- Paused accounts are excluded
- Rate-limited accounts are excluded if their rate limit hasn't expired

### 3. Session Management
The SessionStrategy manages account sessions through the following process:

1. **Active Session Search**: Finds the account with the most recent active session
2. **Session Validation**: Checks if the session is within the configured duration
3. **Account Ordering**: Returns accounts in priority order:
   - Active session account (if available) comes first
   - Other available accounts are sorted by priority (lower values first) as fallback options

### 4. Session Reset
Sessions are reset when:
- No active session exists
- The current session has expired
- A new account needs to be selected

```typescript
private resetSessionIfExpired(account: Account): void {
    const now = Date.now();
    
    if (!account.session_start || 
        now - account.session_start >= this.sessionDurationMs) {
        // Reset session via StrategyStore
        this.store.resetAccountSession(account.id, now);
        account.session_start = now;
        account.session_request_count = 0;
    }
}
```

### 5. Database Updates
The StrategyStore interface provides methods for session management:
- `resetAccountSession(accountId, timestamp)`: Resets session start time and request count
- `updateAccountRequestCount(accountId, count)`: Updates request count for an account
- `getAccount(accountId)`: Retrieves account information

## Performance Considerations

### Session-Based Performance

The session strategy provides excellent rate limit avoidance at the cost of potentially uneven load distribution:

- **Rate Limit Avoidance**: By maintaining sessions with individual accounts for extended periods, the strategy minimizes the risk of hitting rate limits due to rapid account switching.
- **Load Distribution**: Load may concentrate on fewer accounts during a session window. This is acceptable for most use cases but should be monitored.
- **Failover**: If the active session account becomes unavailable, the system automatically fails over to the next available account.

### Session Storage

Session information is stored directly in the database with the following fields:
- `session_start`: Timestamp when the current session began
- `session_request_count`: Number of requests in the current session
- `rate_limited_until`: Timestamp when rate limiting expires (if applicable)

These fields are updated synchronously to ensure consistency in account selection.

### Monitoring

Monitor these key metrics:
- Account usage distribution
- Rate limit occurrences
- Session duration effectiveness
- Failover frequency

## Important: Why Only Session-Based Strategy

**⚠️ WARNING: Only the session-based load balancer strategy is available in better-ccflare.**

Other strategies like round-robin, least-requests, or weighted distribution have been removed from the codebase as they can trigger Claude's anti-abuse systems and result in automatic account bans. Here's why they were removed:

### Account Ban Risks

1. **Rapid Account Switching**: Strategies that frequently switch between accounts create suspicious patterns that Claude's systems detect as potential abuse.

2. **Unnatural Usage Patterns**: Round-robin and similar strategies create artificial request patterns that don't match normal human usage.

3. **Rate Limit Triggering**: Frequent account switching increases the likelihood of hitting rate limits across multiple accounts simultaneously.

### Why Session-Based is Safe

The session-based strategy mimics natural user behavior:
- Maintains consistent sessions with individual accounts
- Reduces account switching to once every 5 hours (configurable)
- Creates usage patterns similar to a regular Claude user
- Minimizes the risk of triggering anti-abuse systems

### Best Practices

1. **Always use session-based strategy**: This is the only strategy that won't risk your accounts
2. **Configure appropriate session duration**: Default 5 hours is recommended
3. **Monitor account health**: Watch for any rate limit issues or warnings
4. **Avoid custom strategies**: Do not implement custom load balancing strategies unless you fully understand the risks

If you need different behavior, adjust the session duration rather than switching strategies:
```json
{
    "lb_strategy": "session",
    "session_duration_ms": 18000000  // 5 hours (recommended)
}
```

## LoadBalancingStrategy Interface

For reference, here's the interface that all load balancing strategies must implement:

```typescript
// From types/context.ts
export interface LoadBalancingStrategy {
    /**
     * Return a filtered & ordered list of candidate accounts.
     * Accounts that are rate-limited should be filtered out.
     * The first account in the list should be tried first.
     */
    select(accounts: Account[], meta: RequestMeta): Account[];

    /**
     * Optional initialization method to inject dependencies
     * Used for strategies that need access to a StrategyStore
     */
    initialize?(store: StrategyStore): void;
}
```

The `RequestMeta` object contains:
- `id`: Unique request identifier
- `method`: HTTP method
- `path`: Request path
- `timestamp`: Request timestamp
- `agentUsed`: Optional agent identifier

Currently, only the `SessionStrategy` implementation exists in the codebase at `/packages/load-balancer/src/strategies/index.ts`.