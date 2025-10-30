# better-ccflare CLI Documentation

The better-ccflare CLI provides a command-line interface for managing OAuth accounts, monitoring usage statistics, and controlling the load balancer.

## Table of Contents

- [Installation and Setup](#installation-and-setup)
- [Global Options and Help](#global-options-and-help)
- [Command Reference](#command-reference)
  - [Account Management](#account-management)
  - [Account Priorities](#account-priorities)
  - [Statistics and History](#statistics-and-history)
  - [System Commands](#system-commands)
  - [Server and Monitoring](#server-and-monitoring)
- [Usage Examples](#usage-examples)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Installation and Setup

### Prerequisites

- Bun runtime (>= 1.2.8)
- Node.js compatible system

### Installation

1. Clone the repository:
```bash
git clone https://github.com/tombii/better-ccflare.git
cd better-ccflare
```

2. Install dependencies:
```bash
bun install
```

3. Build the CLI:
```bash
bun run build
```

4. Run the CLI:
```bash
bun run cli [command]
# or if globally installed:
better-ccflare [command]
```

### First-time Setup

1. Add your first OAuth account:
```bash
bun run cli --add-account myaccount --mode claude-oauth --priority 0
```

2. Start the load balancer server:
```bash
bun run cli --serve
# or just:
bun start
```

## Global Options and Help

### Getting Help

Display all available commands and options:

```bash
bun run cli --help
```

Or use the short form:

```bash
bun run cli -h
```

### Help Output Format

```
🎯 better-ccflare - Load Balancer for Claude

Usage: better-ccflare [options]

Options:
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --mode <claude-oauth|console>  Account mode (default: claude-oauth)
    --priority <number>    Account priority (0-100, default: 0)
  --list               List all accounts
  --remove <name>      Remove an account
  --pause <name>       Pause an account
  --resume <name>      Resume an account
  --set-priority <name> <priority> Set account priority (0-100)
  --analyze            Analyze database performance
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --help, -h           Show this help message

Default Mode:
  bun run cli             Start server (default behavior)
```

## Command Reference

### Account Management

#### `--add-account <name>`

Add a new OAuth account to the load balancer pool.

**Syntax:**
```bash
bun run cli --add-account <name> --mode <claude-oauth|console|zai|openai-compatible> --priority <number>
```

**Note:** All flags must be provided explicitly as the CLI requires explicit parameters.

**Required Options:**
- `--mode`: Account type (required)
  - `claude-oauth`: Claude CLI OAuth account
  - `console`: Claude API account
  - `zai`: z.ai account (API key)
  - `openai-compatible`: OpenAI-compatible provider (API key)
- `--priority`: Account priority (optional, defaults to 0)
  - Range: 0-100
  - Lower numbers indicate higher priority in load balancing

**Account Setup Process:**
1. Execute command with all required flags
2. For OAuth accounts (claude-oauth/console), opens browser for authentication
3. Waits for OAuth callback on localhost:7856
4. For API key accounts (zai/openai-compatible), prompts for API key
5. Stores account credentials securely in the database

#### `--list`

Display all configured accounts with their current status.

**Syntax:**
```bash
bun run cli --list
```

**Output Format:**
```
Accounts:
  - account1 (claude-oauth mode, priority 10)
  - account2 (console mode, priority 5)
```

#### `--remove <name>`

Remove an account from the configuration.

**Syntax:**
```bash
bun run cli --remove <name>
```

**Behavior:**
- Removes account from database immediately
- Cleans up associated session data
- Account removal is immediate with no confirmation prompts

#### `--pause <name>`

Temporarily exclude an account from the load balancer rotation.

**Syntax:**
```bash
bun run cli --pause <name>
```

**Use Cases:**
- Account experiencing issues
- Manual rate limit management
- Maintenance or debugging

#### `--resume <name>`

Re-enable a paused account for load balancing.

**Syntax:**
```bash
bun run cli --resume <name>
```

### Account Priorities

#### `--set-priority <name> <priority>`

Set or update the priority of an account. Accounts with lower priority numbers are preferred in the load balancing algorithm.

**Syntax:**
```bash
bun run cli --set-priority <name> <priority>
```

**Parameters:**
- `name`: Account name to update
- `priority`: Priority value (0-100, where lower numbers indicate higher priority)

**How Priorities Work:**
- Accounts with lower priority numbers are selected first
- Default priority is 0 if not specified
- Priority affects both primary account selection and fallback order
- Changes take effect immediately without restarting the server

**Example:**
```bash
# Set account to high priority (low number)
bun run cli --set-priority production-account 10

# Set account to medium priority
bun run cli --set-priority development-account 50

# Set account to low priority (high number)
bun run cli --set-priority backup-account 90
```

### Statistics and History

#### `--stats`

Display current statistics in JSON format.

**Syntax:**
```bash
bun run cli --stats
```

**Output:**
Returns JSON-formatted statistics including account usage, request counts, and performance metrics.

#### `--reset-stats`

Reset request counters for all accounts.

**Syntax:**
```bash
bun run cli --reset-stats
```

**Effects:**
- Resets request counts to 0
- Preserves account configuration
- Does not affect rate limit timers

#### `--clear-history`

Remove all request history records.

**Syntax:**
```bash
bun run cli --clear-history
```

**Effects:**
- Deletes request log entries
- Preserves account data
- Reports number of records cleared

### System Commands

#### `--analyze`

Analyze database performance and index usage.

**Syntax:**
```bash
bun run cli --analyze
```

**Output:**
- Database performance metrics
- Index usage statistics
- Query optimization suggestions

#### Default Behavior

When no command is specified, the CLI starts the server by default:

```bash
bun run cli
# Equivalent to:
bun run cli --serve
```

### Server and Monitoring

#### `--serve`

Start the API server with dashboard.

**Syntax:**
```bash
bun run cli --serve [--port <number>]
```

**Options:**
- `--port`: Server port (default: 8080, or PORT env var)

**Access:**
- API endpoint: `http://localhost:8080`
- Dashboard: `http://localhost:8080/dashboard`

#### `--logs [N]`

Stream request logs in real-time.

**Syntax:**
```bash
bun run cli --logs [N]
```

**Options:**
- `N`: Number of historical lines to display before streaming (optional)

**Examples:**
```bash
# Stream live logs only
bun run cli --logs

# Show last 50 lines then stream
bun run cli --logs 50
```

## Usage Examples

### Basic Account Setup

```bash
# Add a Claude CLI OAuth account with high priority (low number)
bun run cli --add-account work-account --mode claude-oauth --priority 10

# Add a Console account with medium priority
bun run cli --add-account personal-account --mode console --priority 50

# Add a backup account with low priority (high number)
bun run cli --add-account backup-account --mode claude-oauth --priority 90

# List all accounts
bun run cli --list

# Update account priority
bun run cli --set-priority backup-account 20

# View statistics
bun run cli --stats
```

### Server Operations

```bash
# Start server on default port
bun run cli --serve
# or simply:
bun start

# Start server on custom port
bun run cli --serve --port 3000

# Stream logs
bun run cli --logs

# View last 100 lines then stream
bun run cli --logs 100
```

### Managing Rate Limits

```bash
# Pause account hitting rate limits
bun run cli --pause work-account

# Resume after cooldown
bun run cli --resume work-account

# Reset statistics for fresh start
bun run cli --reset-stats
```

### Maintenance Operations

```bash
# Remove account
bun run cli --remove old-account

# Clear old request logs
bun run cli --clear-history

# Analyze database performance
bun run cli --analyze
```

### Automation Examples

```bash
# Add multiple accounts with different priorities
bun run cli --add-account "primary-account" --mode max --priority 10
bun run cli --add-account "secondary-account" --mode max --priority 50
bun run cli --add-account "backup-account" --mode max --priority 90

# Monitor account status
watch -n 5 'bun run cli --list'

# Automated cleanup
bun run cli --clear-history && bun run cli --reset-stats

# Export statistics for monitoring
bun run cli --stats > stats.json

# Prioritize specific account temporarily
bun run cli --set-priority primary-account 5
# ... run important workload ...
bun run cli --set-priority primary-account 10  # Restore normal priority
```

## Configuration

### Configuration File Location

better-ccflare stores its configuration in platform-specific directories:

#### macOS/Linux
```
~/.config/better-ccflare/better-ccflare.json
```

Or if `XDG_CONFIG_HOME` is set:
```
$XDG_CONFIG_HOME/better-ccflare/better-ccflare.json
```

#### Windows
```
%LOCALAPPDATA%\better-ccflare\better-ccflare.json
```

Or fallback to:
```
%APPDATA%\better-ccflare\better-ccflare.json
```

### Configuration Structure

```json
{
  "lb_strategy": "session",
  "client_id": "optional-custom-client-id",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080
}
```

### Database Location

The SQLite database follows the same directory structure:
- **macOS/Linux**: `~/.config/better-ccflare/better-ccflare.db`
- **Windows**: `%LOCALAPPDATA%\better-ccflare\better-ccflare.db`

## Environment Variables

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `better-ccflare_CONFIG_PATH` | Override config file location | Platform default |
| `better-ccflare_DB_PATH` | Override database location | Platform default |
| `PORT` | Server port | 8080 |
| `CLIENT_ID` | OAuth client ID | 9d1c250a-e61b-44d9-88ed-5944d1962f5e |

### Load Balancing

| Variable | Description | Default |
|----------|-------------|---------|
| `LB_STRATEGY` | Load balancing strategy (only 'session' is supported) | session |

### Retry Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `RETRY_ATTEMPTS` | Number of retry attempts | 3 |
| `RETRY_DELAY_MS` | Initial retry delay (ms) | 1000 |
| `RETRY_BACKOFF` | Exponential backoff multiplier | 2 |

### Session Management

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_DURATION_MS` | OAuth session duration (ms) | 18000000 (5 hours) |

### Logging and Debugging

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Log verbosity (DEBUG/INFO/WARN/ERROR) | INFO |
| `LOG_FORMAT` | Output format (pretty/json) | pretty |
| `better-ccflare_DEBUG` | Enable debug mode (1/0) - enables console output | 0 |

### Pricing and Features

| Variable | Description | Default |
|----------|-------------|---------|
| `CF_PRICING_REFRESH_HOURS` | Pricing cache duration | 24 |
| `CF_PRICING_OFFLINE` | Offline mode flag (1/0) | 0 |

## Troubleshooting

### Common Issues

#### OAuth Authentication Fails

**Problem**: Browser doesn't open or OAuth callback fails

**Solutions**:
1. Ensure default browser is configured
2. Check firewall settings for localhost:7856
3. Manually copy OAuth URL from terminal
4. Verify network connectivity

#### Account Shows as "Expired"

**Problem**: Token status shows expired

**Solutions**:
1. Remove and re-add the account
2. Check system time synchronization
3. Verify OAuth session hasn't exceeded 5-hour limit

#### Rate Limit Errors

**Problem**: Accounts hitting rate limits frequently

**Solutions**:
1. Add more accounts to the pool
2. Increase session duration for less frequent switching
3. Implement request throttling in client code
4. Monitor usage with `bun cli list`

#### Database Errors

**Problem**: "Database is locked" or corruption errors

**Solutions**:
1. Stop all better-ccflare processes
2. Check file permissions on database
3. Backup and recreate if corrupted:
   ```bash
   cp ~/.config/better-ccflare/better-ccflare.db ~/.config/better-ccflare/better-ccflare.db.backup
   rm ~/.config/better-ccflare/better-ccflare.db
   ```

### Debug Mode

Enable detailed logging for troubleshooting:

```bash
# Enable debug logging
export BETTER_CCFLARE_DEBUG=1
export LOG_LEVEL=DEBUG

# Run with verbose output
bun run cli --list

# Stream debug logs
bun run cli --logs
```

### Getting Support

1. Check existing documentation in `/docs`
2. Review debug logs for detailed error messages
3. Ensure all dependencies are up to date
4. File an issue with reproduction steps

### Best Practices

1. **Regular Maintenance**
   - Clear history periodically to manage database size
   - Reset stats monthly for accurate metrics
   - Monitor account health with regular `bun run cli --list` commands
   - Use `bun run cli --analyze` to optimize database performance

2. **Account Management**
   - Use descriptive account names
   - Distribute load across multiple accounts
   - Use account priorities to control load distribution:
     - Set lower priority numbers for premium or preferred accounts
     - Use higher priority numbers for backup or development accounts
     - Adjust priorities temporarily for specific workloads
   - Pause accounts proactively when approaching rate limits

3. **Security**
   - Protect configuration directory permissions
   - Don't share OAuth tokens or session data
   - Rotate accounts periodically
   - Monitor logs with `bun run cli --logs` for suspicious activity

4. **Performance**
   - Use accounts with higher rate limits for heavy workloads
   - Implement client-side retry logic
   - Monitor rate limit patterns with `bun run cli --stats`
   - Run server with `bun run cli --serve` for production use