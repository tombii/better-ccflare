# Database Documentation

## Overview

Claudeflare uses SQLite as its database engine, providing a lightweight, serverless, and efficient storage solution for managing OAuth accounts, request history, and usage statistics. The database is designed to support high-performance load balancing operations while maintaining detailed audit trails and rate limit tracking.

### Key Features
- **Zero-configuration** deployment with SQLite
- **Automatic migrations** to handle schema evolution
- **Thread-safe operations** using Bun's SQLite bindings
- **Comprehensive indexing** for fast query performance
- **Foreign key constraints** for data integrity
- **Asynchronous write operations** for improved performance
- **Singleton pattern** with dependency injection support

## Database Schema

### Entity Relationship Diagram

```mermaid
erDiagram
    accounts {
        TEXT id PK "UUID primary key"
        TEXT name "Display name for the account"
        TEXT provider "OAuth provider (default: anthropic)"
        TEXT api_key "API key (optional)"
        TEXT refresh_token "OAuth refresh token"
        TEXT access_token "OAuth access token"
        INTEGER expires_at "Token expiration timestamp"
        INTEGER created_at "Account creation timestamp"
        INTEGER last_used "Last request timestamp"
        INTEGER request_count "Total requests in current period"
        INTEGER total_requests "All-time request count"
        INTEGER rate_limited_until "Rate limit expiration timestamp"
        INTEGER session_start "Current session start timestamp"
        INTEGER session_request_count "Requests in current session"
        INTEGER account_tier "Account tier (1, 5, or 20)"
        INTEGER paused "Account pause status (0 or 1)"
        INTEGER rate_limit_reset "Next rate limit reset timestamp"
        TEXT rate_limit_status "Current rate limit status"
        INTEGER rate_limit_remaining "Remaining requests before limit"
    }
    
    requests {
        TEXT id PK "UUID primary key"
        INTEGER timestamp "Request timestamp"
        TEXT method "HTTP method"
        TEXT path "Request path"
        TEXT account_used FK "Account ID used (nullable)"
        INTEGER status_code "HTTP response status"
        BOOLEAN success "Request success flag"
        TEXT error_message "Error details if failed"
        INTEGER response_time_ms "Response latency"
        INTEGER failover_attempts "Number of retry attempts"
        TEXT model "AI model used"
        INTEGER prompt_tokens "Input token count"
        INTEGER completion_tokens "Output token count"
        INTEGER total_tokens "Total token count"
        REAL cost_usd "Estimated cost in USD"
        INTEGER input_tokens "Detailed input tokens"
        INTEGER cache_read_input_tokens "Cached input tokens read"
        INTEGER cache_creation_input_tokens "Cached input tokens created"
        INTEGER output_tokens "Detailed output tokens"
    }
    
    request_payloads {
        TEXT id PK "Request ID (foreign key)"
        TEXT json "Full request/response JSON payload"
    }
    
    accounts ||--o{ requests : "handles"
    requests ||--|| request_payloads : "has payload"
```

## Table Documentation

### accounts Table

The `accounts` table stores OAuth account information and usage statistics for load balancing.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID identifier for the account |
| `name` | TEXT | NOT NULL | Human-readable name for the account |
| `provider` | TEXT | DEFAULT 'anthropic' | OAuth provider identifier |
| `api_key` | TEXT | NULL | Optional API key for non-OAuth providers |
| `refresh_token` | TEXT | NOT NULL | OAuth refresh token for token renewal |
| `access_token` | TEXT | NULL | Current OAuth access token |
| `expires_at` | INTEGER | NULL | Unix timestamp when access token expires |
| `created_at` | INTEGER | NOT NULL | Unix timestamp when account was added |
| `last_used` | INTEGER | NULL | Unix timestamp of last request |
| `request_count` | INTEGER | DEFAULT 0 | Rolling window request count |
| `total_requests` | INTEGER | DEFAULT 0 | All-time request count |
| `rate_limited_until` | INTEGER | NULL* | Unix timestamp when rate limit expires |
| `session_start` | INTEGER | NULL* | Start of current usage session |
| `session_request_count` | INTEGER | DEFAULT 0* | Requests in current session |
| `account_tier` | INTEGER | DEFAULT 1* | Account tier (1=Free, 5=Pro, 20=Team) |
| `paused` | INTEGER | DEFAULT 0* | 1 if account is paused, 0 if active |
| `rate_limit_reset` | INTEGER | NULL* | Next rate limit window reset time |
| `rate_limit_status` | TEXT | NULL* | Current rate limit status message |
| `rate_limit_remaining` | INTEGER | NULL* | Remaining requests in current window |

*Note: Columns marked with * are added via migrations and may not exist in databases created before the migration was introduced.

### requests Table

The `requests` table logs all proxied requests for analytics and debugging.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID identifier for the request |
| `timestamp` | INTEGER | NOT NULL | Unix timestamp when request was made |
| `method` | TEXT | NOT NULL | HTTP method (GET, POST, etc.) |
| `path` | TEXT | NOT NULL | Request path/endpoint |
| `account_used` | TEXT | NULL | Account ID that handled the request |
| `status_code` | INTEGER | NULL | HTTP response status code |
| `success` | BOOLEAN | NULL | 1 for success, 0 for failure |
| `error_message` | TEXT | NULL | Error details if request failed |
| `response_time_ms` | INTEGER | NULL | Total response time in milliseconds |
| `failover_attempts` | INTEGER | DEFAULT 0 | Number of retry attempts |
| `model` | TEXT | NULL* | AI model used (e.g., claude-3-sonnet) |
| `prompt_tokens` | INTEGER | DEFAULT 0* | Legacy: Input token count |
| `completion_tokens` | INTEGER | DEFAULT 0* | Legacy: Output token count |
| `total_tokens` | INTEGER | DEFAULT 0* | Legacy: Total token count |
| `cost_usd` | REAL | DEFAULT 0* | Estimated cost in USD |
| `input_tokens` | INTEGER | DEFAULT 0* | Detailed input token count |
| `cache_read_input_tokens` | INTEGER | DEFAULT 0* | Tokens read from cache |
| `cache_creation_input_tokens` | INTEGER | DEFAULT 0* | Tokens written to cache |
| `output_tokens` | INTEGER | DEFAULT 0* | Detailed output token count |

*Note: Columns marked with * are added via migrations and may not exist in databases created before the migration was introduced.

**Indexes:**
- `idx_requests_timestamp` on `timestamp DESC` for efficient time-based queries

### request_payloads Table

The `request_payloads` table stores full request and response bodies for detailed analysis.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY, FOREIGN KEY | References requests.id |
| `json` | TEXT | NOT NULL | Complete request/response JSON data |

**Foreign Key Constraints:**
- `id` references `requests(id)` with `ON DELETE CASCADE`

## Migration System

The database uses an incremental migration system that:

1. **Ensures Base Schema**: Creates core tables if they don't exist
2. **Applies Migrations**: Checks for missing columns and adds them incrementally
3. **Preserves Data**: All migrations are additive, never destructive
4. **Logs Changes**: Outputs migration progress to console

### Migration Process

```typescript
// Migration execution order:
1. ensureSchema(db)      // Creates base tables
2. runMigrations(db)     // Applies incremental changes
```

Key migrations include:
- Rate limiting columns (`rate_limited_until`, `rate_limit_status`, etc.)
- Session tracking (`session_start`, `session_request_count`)
- Account tiers and pausing
- Token usage tracking for cost analysis

## Database Architecture

### Core Components

#### DatabaseOperations
The main database access layer that implements both `StrategyStore` and `Disposable` interfaces:
- Manages direct SQLite connections via Bun's native SQLite bindings
- Handles all CRUD operations for accounts and requests
- Supports runtime configuration injection for session management
- Thread-safe for concurrent operations

#### DatabaseFactory
Singleton pattern implementation for global database instance management:
- Ensures a single database connection throughout the application
- Provides `initialize()` and `getInstance()` methods
- Integrates with the dependency injection container

#### AsyncDbWriter
Asynchronous write queue for non-blocking database operations:
- Batches write operations to improve performance
- Processes queue every 100ms or immediately when jobs are added
- Gracefully flushes pending operations on shutdown
- Prevents blocking the main thread during heavy write loads

### Dependency Injection Integration
The database integrates with the DI container:
```typescript
// Registration in container
container.registerInstance(SERVICE_KEYS.Database, dbOps);

// Resolution from container
const db = container.resolve<DatabaseOperations>(SERVICE_KEYS.Database);
```

## Database Location and Configuration

### Default Location

The database file is stored in a platform-specific configuration directory:

- **macOS**: `~/Library/Application Support/claudeflare/claudeflare.db`
- **Linux**: `~/.config/claudeflare/claudeflare.db`
- **Windows**: `%APPDATA%\claudeflare\claudeflare.db`

### Custom Location

You can override the default location using the `CLAUDEFLARE_DB_PATH` environment variable:

```bash
export CLAUDEFLARE_DB_PATH=/custom/path/to/database.db
```

### Runtime Configuration

The database supports runtime configuration for dynamic behavior:
```typescript
interface RuntimeConfig {
  sessionDurationMs?: number; // Default: 5 hours (5 * 60 * 60 * 1000)
}
```

### Database Initialization

The database is automatically initialized with:
- Directory creation if needed
- Schema creation on first use
- Migration application on startup
- Foreign key constraint enforcement

## Query Patterns and Indexes

### Common Query Patterns

1. **Account Selection for Load Balancing**
```sql
SELECT * FROM accounts 
WHERE paused = 0 
  AND (rate_limited_until IS NULL OR rate_limited_until < ?)
ORDER BY session_request_count ASC
```

2. **Request History Analysis**
```sql
SELECT * FROM requests 
WHERE timestamp >= ? 
ORDER BY timestamp DESC
LIMIT ?
```

3. **Usage Statistics by Account**
```sql
SELECT 
  account_used,
  COUNT(*) as request_count,
  AVG(response_time_ms) as avg_response_time,
  SUM(cost_usd) as total_cost
FROM requests
WHERE timestamp >= ?
GROUP BY account_used
```

4. **Request Payloads with Account Names**
```sql
SELECT rp.id, rp.json, a.name as account_name
FROM request_payloads rp
JOIN requests r ON rp.id = r.id
LEFT JOIN accounts a ON r.account_used = a.id
ORDER BY r.timestamp DESC
LIMIT ?
```

### Index Strategy

Current indexes optimize for:
- **Time-series queries**: `idx_requests_timestamp` enables fast filtering and sorting by time
- **Primary key lookups**: Automatic indexes on all primary keys
- **Foreign key joins**: Automatic indexes for referential integrity

Additional indexes to consider for production:
```sql
-- For account selection performance
CREATE INDEX idx_accounts_active ON accounts(paused, rate_limited_until);

-- For request analysis by account
CREATE INDEX idx_requests_account_timestamp ON requests(account_used, timestamp);
```

## Performance Considerations

### SQLite Optimization

1. **WAL Mode**: Consider enabling Write-Ahead Logging for better concurrency:
```sql
PRAGMA journal_mode = WAL;
```

2. **Connection Pooling**: The current implementation uses a single connection. For high-load scenarios, consider connection pooling.

3. **Query Optimization**:
   - Use prepared statements (already implemented via Bun's query API)
   - Batch operations where possible
   - Limit result sets with appropriate `LIMIT` clauses

### Data Growth Management

1. **Request History**: Implement periodic cleanup of old request records:
```sql
DELETE FROM requests WHERE timestamp < ?;
DELETE FROM request_payloads WHERE id NOT IN (SELECT id FROM requests);
```

2. **Payload Storage**: Consider external storage for large payloads to prevent database bloat.

3. **Statistics Aggregation**: Pre-aggregate statistics for common time windows to reduce query complexity.

## API Methods

### Core Database Operations

#### Account Management
- `getAllAccounts()`: Retrieve all accounts with computed fields
- `getAccount(accountId: string)`: Get a specific account by ID
- `updateAccountTokens(accountId, accessToken, expiresAt)`: Update OAuth tokens
- `updateAccountUsage(accountId)`: Increment usage counters and manage sessions
- `updateAccountTier(accountId, tier)`: Set account tier (1, 5, or 20)
- `pauseAccount(accountId)` / `resumeAccount(accountId)`: Toggle account availability

#### Rate Limiting
- `markAccountRateLimited(accountId, until)`: Set rate limit expiration
- `updateAccountRateLimitMeta(accountId, status, reset, remaining?)`: Update rate limit metadata
- `resetAccountSession(accountId, timestamp)`: Reset session counters

#### Request Tracking
- `saveRequest(id, method, path, ...)`: Log request with full metadata
- `updateRequestUsage(requestId, usage)`: Update token usage after request completion
- `saveRequestPayload(id, data)`: Store request/response JSON
- `getRequestPayload(id)`: Retrieve specific payload
- `listRequestPayloads(limit?)`: List recent payloads
- `listRequestPayloadsWithAccountNames(limit?)`: List payloads with account names

## CLI Commands

The database can be managed through CLI commands:

### Account Management
```bash
# Add a new account
bun cli add <name> [--mode <max|console>] [--tier <1|5|20>]

# List all accounts with status
bun cli list

# Remove an account
bun cli remove <name>

# Pause/resume an account
bun cli pause <name>
bun cli resume <name>
```

### Database Maintenance
```bash
# Reset all usage statistics
bun cli reset-stats

# Clear all request history
bun cli clear-history
```

These commands directly interact with the database through the `DatabaseOperations` class.

## Backup and Maintenance

### Backup Strategies

1. **File-based Backup**: Simple copy of the SQLite file when the application is stopped:
```bash
cp claudeflare.db claudeflare.db.backup
```

2. **Online Backup**: Use SQLite's backup API for hot backups:
```sql
VACUUM INTO 'backup.db';
```

3. **Automated Backups**: Schedule regular backups using cron or system schedulers:
```bash
# Daily backup with rotation
0 2 * * * cp /path/to/claudeflare.db /backups/claudeflare-$(date +\%Y\%m\%d).db
```

### Maintenance Operations

The following maintenance operations are available through the CLI:

1. **Reset Statistics**:
```bash
# Resets request_count, session_start, and session_request_count for all accounts
bun cli reset-stats
```

2. **Clear History**:
```bash
# Removes all entries from the requests table
bun cli clear-history
```

3. **Manual Cleanup** (via SQL):
```sql
-- Clean up old requests (keep last 30 days)
DELETE FROM requests WHERE timestamp < strftime('%s', 'now') * 1000 - 30 * 24 * 60 * 60 * 1000;

-- Clean up orphaned payloads
DELETE FROM request_payloads WHERE id NOT IN (SELECT id FROM requests);
```

### Integrity Checks

Regular integrity checks should be performed:
```sql
-- Check database integrity
PRAGMA integrity_check;

-- Check foreign key constraints
PRAGMA foreign_key_check;

-- Analyze and optimize
ANALYZE;
VACUUM;
```

### Monitoring

Key metrics to monitor:
- Database file size growth
- Query performance (especially account selection)
- Request table row count
- Failed request rate
- Rate limit violations per account

## Security Considerations

1. **Token Storage**: OAuth tokens are stored in plaintext. In production environments, consider:
   - Encrypting sensitive columns
   - Using OS-level file encryption
   - Restricting file permissions

2. **Access Control**: Ensure proper file permissions:
```bash
chmod 600 claudeflare.db
```

3. **SQL Injection**: The codebase uses parameterized queries throughout, providing protection against SQL injection.

## Future Enhancements

1. **Partitioning**: Consider partitioning the requests table by timestamp for better performance with large datasets.

2. **Replication**: Add read replicas for analytics queries without impacting operational performance.

3. **Migration Versioning**: Implement a formal migration version tracking system with a `migrations` table to track applied migrations.

4. **Audit Logging**: Add a separate audit table for security-sensitive operations like account modifications and token refreshes.

5. **Performance Metrics**: Store query performance metrics for optimization.

6. **Encryption**: Implement column-level encryption for sensitive data (tokens, API keys).

7. **Compression**: Enable compression for the `request_payloads` table to reduce storage requirements.

8. **Analytics Tables**: Create pre-aggregated tables for common analytics queries.

9. **Connection Pooling**: Implement connection pooling for high-concurrency scenarios.

10. **Streaming Backups**: Implement streaming backups to cloud storage providers.