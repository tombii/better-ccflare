# Claudeflare - Claude Load Balancer

A load balancer proxy for multiple Claude OAuth accounts with automatic failover, request tracking, and web dashboard. Built as a Bun monorepo for modularity and extensibility.

## Why?

Ever get tired of Claude's rate limiting?

https://github.com/user-attachments/assets/9b45bc1c-9069-4190-99e0-bba53a0a62ee

## Why Session-Based by Default?

The default session-based strategy ensures you get the most out of Claude's prompt caching:
- **Sticky Sessions**: Uses one account exclusively for 5 hours, maximizing cache hits
- **Automatic Failover**: When that account hits rate limits, seamlessly switches to the next
- **Cost Effective**: Better cache utilization means lower costs per request
- **Simple**: No complex distribution logic - just use one account until you can't

## Example

![Example Dashboard](./example_dashboard.png)

![Example Log](./example_log.png)

## Features

- **Sticky Session Load Balancing**: Default 5-hour sessions that use one account exclusively until rate limited, maximizing Claude's prompt caching
- **Load Balancing**: Multiple strategies including tier-aware distribution
- **Account Tiers**: Support for Pro (1x), Max 5x, and Max 20x accounts
- **Automatic Failover**: When rate-limited, seamlessly switches to next available account
- **Rate Limit Detection**: Automatically detects and respects rate limits
- **Retry Logic**: Configurable retries per account with exponential backoff (3 retries by default)
- **Request Tracking**: Stores all requests in a database for monitoring
- **Web Dashboard**: Real-time monitoring UI with strategy switching and tier management
- **Enhanced Logging**: Detailed logging with configurable levels
- **Token Management**: Automatic token refresh when expired
- **Hot Configuration**: Change strategies without restarting the server
- **Extensible Architecture**: Provider-based proxy system for future AI provider support

## Installation

```bash
bun install
```

## Usage

### 1. Add Claude Accounts

Use the CLI to add your Claude accounts:

```bash
# Interactive mode - will prompt for account type and tier
bun run cli add myaccount

# Add an API account (console.anthropic.com)
bun run cli add api-account --mode console

# Add a Max account with tier selection
bun run cli add max-account --mode max  # Will prompt for tier

# Add specific tier Max accounts
bun run cli add pro --mode max --tier 1      # Pro Account (1x)
bun run cli add premium --mode max --tier 5   # Max 5x Account
bun run cli add enterprise --mode max --tier 20  # Max 20x Account
```

When prompted:
- **Account Type**: Choose between API (console.anthropic.com) or Claude Max (claude.ai)
- **Tier** (Max accounts only): Select capacity multiplier (1x, 5x, or 20x)

Follow the authorization prompts for each account.

### 2. Start the Server

```bash
bun start
```

The server will start on port 8080 (or the PORT environment variable).

### 3. Access the Dashboard

Open your browser and navigate to:
- Dashboard: http://localhost:8080/dashboard
- Health Check: http://localhost:8080/health

### 4. Use as Proxy

Configure your Claude Code to use the load balancer:

```
export ANTHROPIC_BASE_URL=http://localhost:8080
```

## CLI Commands

```bash
# Add a new account (interactive mode)
bun run cli add <name>

# Add with specific options
bun run cli add <name> [--mode max|console] [--tier 1|5|20]

# List all accounts with tier information
bun run cli list

# Remove an account
bun run cli remove <name>

# Reset usage statistics
bun run cli reset-stats

# Clear request history
bun run cli clear-history

# Show help
bun run cli help
```

## API Endpoints

- `GET /` - Web dashboard
- `GET /dashboard` - Web dashboard (alias)
- `GET /health` - Health check endpoint
- `GET /api/stats` - Get aggregated statistics
- `GET /api/accounts` - Get account information with tiers
- `GET /api/requests?limit=50` - Get recent requests
- `GET /api/config` - Get current configuration
- `GET /api/config/strategy` - Get current load balancing strategy
- `POST /api/config/strategy` - Update load balancing strategy
- `POST /api/accounts/:id/tier` - Update account tier
- `/v1/*` - Proxy to Anthropic API

## How It Works

1. **Load Balancing Strategies**:
   - **Session Based** (default): Sticky 5-hour sessions - uses one account exclusively until rate limited, then switches to the next. This maximizes Claude's prompt caching benefits.
   - **Least Requests**: Routes to account with fewest total requests
   - **Round Robin**: Distributes requests evenly in circular order
   - **Weighted**: Considers account tiers (1x, 5x, 20x) for fair distribution
   - **Weighted Round Robin**: Round-robin with tier-based slots

2. **Account Tiers**:
   - **Pro (1x)**: Standard capacity
   - **Max 5x**: 5x the capacity of Pro accounts
   - **Max 20x**: 20x the capacity of Pro accounts

3. **Retry Logic**: Each account gets 3 retry attempts with exponential backoff:
   - 1st retry: 1 second delay
   - 2nd retry: 2 seconds delay
   - 3rd retry: 4 seconds delay

4. **Failover**: If all retries fail, moves to the next available account

5. **Rate Limit Handling**: Automatically detects 429 responses and marks accounts as rate-limited

6. **Token Management**: Access tokens are automatically refreshed when expired

7. **Request Tracking**: All requests are logged to a SQLite database

## Dashboard Features

The web dashboard shows:
- **Total Requests**: Number of requests processed
- **Success Rate**: Percentage of successful requests
- **Active Accounts**: Number of configured accounts
- **Average Response Time**: Mean response time across all requests
- **Strategy Selector**: Switch load balancing strategies in real-time
- **Account Management**:
  - Account tiers with visual badges
  - Tier selector to change account capacity
  - Usage statistics and token validity
  - Rate limit status
  - Session information
- **Request History**: Recent requests with details and status

The dashboard auto-refreshes every 5 seconds.

## Logging

The server logs all activity with timestamps and configurable levels:
- `DEBUG`: Detailed debugging information
- `INFO`: Normal operations, requests, and responses
- `WARN`: Failed requests that trigger failover
- `ERROR`: Critical errors and failures

Set the log level with the `LOG_LEVEL` environment variable.

## Configuration

### Environment Variables

```bash
# Server port (default: 8080)
PORT=8080

# Load balancing strategy (default: session)
# Options: session, least-requests, round-robin, weighted, weighted-round-robin
LB_STRATEGY=session

# Log level (default: INFO)
# Options: DEBUG, INFO, WARN, ERROR
LOG_LEVEL=INFO

# Optional: Override config file path
CLAUDEFLARE_CONFIG_PATH=/path/to/config.json
```

### Configuration File

The configuration is stored in JSON format at:
- **Linux/macOS**: `~/.config/claudeflare/claudeflare.json`
- **Windows**: `%LOCALAPPDATA%\claudeflare\claudeflare.json`

Example configuration:

```json
{
  "lb_strategy": "session",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080
}
```

## Architecture

Claudeflare is built as a Bun monorepo with the following structure:

### Apps
- **`apps/server`** - Main HTTP server and proxy
- **`apps/cli`** - Command-line interface for account management

### Packages
- **`@claudeflare/core`** - Core types and interfaces
- **`@claudeflare/database`** - SQLite database operations and migrations
- **`@claudeflare/config`** - Configuration management with hot reloading
- **`@claudeflare/logger`** - Centralized logging utilities
- **`@claudeflare/load-balancer`** - Load balancing strategies
- **`@claudeflare/proxy`** - Provider-based proxy system
- **`@claudeflare/dashboard`** - Web dashboard UI

### Key Design Patterns
- **Provider Abstraction**: Extensible proxy system that can support multiple AI providers
- **Strategy Pattern**: Pluggable load balancing algorithms
- **Event-Driven Config**: Real-time configuration updates without restarts
- **XDG Compliance**: Follows platform conventions for config/data directories

## Development

### Project Structure
```
claudeflare/
├── apps/
│   ├── cli/         # CLI application
│   └── server/      # HTTP server
├── packages/
│   ├── config/      # Configuration management
│   ├── core/        # Core types and interfaces
│   ├── dashboard/   # Web dashboard
│   ├── database/    # Database operations
│   ├── load-balancer/ # Load balancing strategies
│   ├── logger/      # Logging utilities
│   └── proxy/       # Proxy and providers
├── package.json     # Root workspace configuration
└── tsconfig.json    # TypeScript configuration
```

### Building Single Executables

You can compile the apps into single executables:

```bash
# Build server executable
bun build apps/server/src/server.ts --compile --outfile=claudeflare-server

# Build CLI executable
bun build apps/cli/src/cli.ts --compile --outfile=claudeflare-cli
```

## Database

The load balancer uses SQLite to store:
- Account information, tokens, and tiers
- Request history and statistics
- Configuration settings
- Rate limit and session data

Database location:
- **Linux/macOS**: `~/.config/claudeflare/claude-accounts.db`
- **Windows**: `%LOCALAPPDATA%\claudeflare\claude-accounts.db`

## Requirements

- Bun runtime
- SQLite (included with Bun)

This project was created using `bun init` in bun v1.2.8. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.