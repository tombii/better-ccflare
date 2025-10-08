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
better-ccflare [options]
```

### First-time Setup

1. Add your first OAuth account:
```bash
better-ccflare --add-account myaccount
```

2. Start the load balancer server:
```bash
better-ccflare --serve
```

## Global Options and Help

### Getting Help

Display all available commands and options:

```bash
better-ccflare --help
```

Or use the short form:

```bash
better-ccflare -h
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
    --mode <max|console>  Account mode (default: max)
    --tier <1|5|20>       Account tier (default: 1)
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

Interactive Mode:
  better-ccflare          Launch interactive TUI (default)
```

## Command Reference

### Account Management

#### `--add-account <name>`

Add a new OAuth account to the load balancer pool.

**Syntax:**
```bash
better-ccflare --add-account <name> [--mode <max|console>] [--tier <1|5|20>] [--priority <number>]
```

**Options:**
- `--mode`: Account type (optional, defaults to "max")
  - `max`: Claude CLI account
  - `console`: Claude API account
  - `zai`: z.ai account (API key)
  - `openai-compatible`: OpenAI-compatible provider (API key)
- `--tier`: Account tier (optional, defaults to 1)
  - `1`: Tier 1 account
  - `5`: Tier 5 account
  - `20`: Tier 20 account
  - **Note**: Tier is automatically set to 1 for OpenAI-compatible providers and hidden from prompts
- `--priority`: Account priority (optional, defaults to 0)
  - Range: 0-100
  - Lower numbers indicate higher priority in load balancing
  - If not specified, defaults to 0 (highest priority)

**Interactive Flow:**
1. If mode not provided, defaults to "max"
2. If tier not provided (Max accounts only), defaults to 1
3. If priority not provided, defaults to 0
4. Opens browser for OAuth authentication
5. Waits for OAuth callback on localhost:7856
6. Stores account credentials securely in the database

#### `--list`

Display all configured accounts with their current status.

**Syntax:**
```bash
better-ccflare --list
```

**Output Format:**
```
Accounts:
  - account1 (max mode, tier 5, priority 10)
  - account2 (console mode, tier 1, priority 5)
```

#### `--remove <name>`

Remove an account from the configuration.

**Syntax:**
```bash
better-ccflare --remove <name>
```

**Behavior:**
- Removes account from database immediately
- Cleans up associated session data
- For confirmation prompts, use the older `better-ccflare-cli remove <name>` command

#### `--pause <name>`

Temporarily exclude an account from the load balancer rotation.

**Syntax:**
```bash
better-ccflare --pause <name>
```

**Use Cases:**
- Account experiencing issues
- Manual rate limit management
- Maintenance or debugging

#### `--resume <name>`

Re-enable a paused account for load balancing.

**Syntax:**
```bash
better-ccflare --resume <name>
```

### Account Priorities

#### `--set-priority <name> <priority>`

Set or update the priority of an account. Accounts with lower priority numbers are preferred in the load balancing algorithm.

**Syntax:**
```bash
better-ccflare --set-priority <name> <priority>
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
better-ccflare --set-priority production-account 10

# Set account to medium priority
better-ccflare --set-priority development-account 50

# Set account to low priority (high number)
better-ccflare --set-priority backup-account 90
```

### Statistics and History

#### `--stats`

Display current statistics in JSON format.

**Syntax:**
```bash
better-ccflare --stats
```

**Output:**
Returns JSON-formatted statistics including account usage, request counts, and performance metrics.

#### `--reset-stats`

Reset request counters for all accounts.

**Syntax:**
```bash
better-ccflare --reset-stats
```

**Effects:**
- Resets request counts to 0
- Preserves account configuration
- Does not affect rate limit timers

#### `--clear-history`

Remove all request history records.

**Syntax:**
```bash
better-ccflare --clear-history
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
better-ccflare --analyze
```

**Output:**
- Database performance metrics
- Index usage statistics
- Query optimization suggestions

#### Interactive Terminal UI (TUI)

Launch the interactive terminal interface (default mode):

```bash
better-ccflare
```

**Features:**
- Real-time account monitoring
- Request logs viewing
- Performance analytics
- Interactive account management

### Server and Monitoring

#### `--serve`

Start the API server with dashboard.

**Syntax:**
```bash
better-ccflare --serve [--port <number>]
```

**Options:**
- `--port`: Server port (default: 8080, or PORT env var)

**Access:**
- API endpoint: `http://localhost:8080`
- Dashboard: `http://localhost:8080/_dashboard`

#### `--logs [N]`

Stream request logs in real-time.

**Syntax:**
```bash
better-ccflare --logs [N]
```

**Options:**
- `N`: Number of historical lines to display before streaming (optional)

**Examples:**
```bash
# Stream live logs only
better-ccflare --logs

# Show last 50 lines then stream
better-ccflare --logs 50
```

## Usage Examples

### Basic Account Setup

```bash
# Add a Claude CLI account with tier 5 and high priority (low number)
better-ccflare --add-account work-account --mode max --tier 5 --priority 10

# Add a Console account with medium priority
better-ccflare --add-account personal-account --mode console --priority 50

# Add a backup account with low priority (high number)
better-ccflare --add-account backup-account --mode max --tier 1 --priority 90

# List all accounts
better-ccflare --list

# Update account priority
better-ccflare --set-priority backup-account 20

# View statistics
better-ccflare --stats
```

### Server Operations

```bash
# Start server on default port
better-ccflare --serve

# Start server on custom port
better-ccflare --serve --port 3000

# Stream logs
better-ccflare --logs

# View last 100 lines then stream
better-ccflare --logs 100
```

### Managing Rate Limits

```bash
# Pause account hitting rate limits
better-ccflare --pause work-account

# Resume after cooldown
better-ccflare --resume work-account

# Reset statistics for fresh start
better-ccflare --reset-stats
```

### Maintenance Operations

```bash
# Remove account
better-ccflare --remove old-account

# Clear old request logs
better-ccflare --clear-history

# Analyze database performance
better-ccflare --analyze
```

### Interactive Mode

```bash
# Launch interactive TUI (default)
better-ccflare

# TUI launches with auto-started server
# Navigate with arrow keys, tab between sections
```

### Automation Examples

```bash
# Add multiple accounts with different priorities
better-ccflare --add-account "primary-account" --mode max --tier 20 --priority 10
better-ccflare --add-account "secondary-account" --mode max --tier 5 --priority 50
better-ccflare --add-account "backup-account" --mode max --tier 1 --priority 90

# Monitor account status
watch -n 5 'better-ccflare --list'

# Automated cleanup
better-ccflare --clear-history && better-ccflare --reset-stats

# Export statistics for monitoring
better-ccflare --stats > stats.json

# Prioritize specific account temporarily
better-ccflare --set-priority primary-account 5
# ... run important workload ...
better-ccflare --set-priority primary-account 10  # Restore normal priority
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
export better-ccflare_DEBUG=1
export LOG_LEVEL=DEBUG

# Run with verbose output
better-ccflare --list

# Stream debug logs
better-ccflare --logs
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
   - Monitor account health with regular `better-ccflare --list` commands
   - Use `better-ccflare --analyze` to optimize database performance

2. **Account Management**
   - Use descriptive account names
   - Distribute load across multiple accounts
   - Keep accounts of similar tiers for consistent performance
   - Use account priorities to control load distribution:
     - Set lower priority numbers for premium or preferred accounts
     - Use higher priority numbers for backup or development accounts
     - Adjust priorities temporarily for specific workloads
   - Pause accounts proactively when approaching rate limits

3. **Security**
   - Protect configuration directory permissions
   - Don't share OAuth tokens or session data
   - Rotate accounts periodically
   - Monitor logs with `better-ccflare --logs` for suspicious activity

4. **Performance**
   - Use higher-tier accounts for heavy workloads
   - Implement client-side retry logic
   - Monitor rate limit patterns with `better-ccflare --stats`
   - Run server with `better-ccflare --serve` for production use