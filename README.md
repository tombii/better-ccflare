# Claude Load Balancer

A load balancer proxy for multiple Claude OAuth accounts with automatic failover, request tracking, and web dashboard.

## Example

![Example Dashboard](./example_dashboard.png)

![Example Log](./example_log.png)

## Features

- **Load Balancing**: Distributes requests across multiple Claude accounts
- **Automatic Failover**: If a request fails with one account, automatically retries with others
- **Retry Logic**: Configurable retries per account with exponential backoff (3 retries by default)
- **Request Tracking**: Stores all requests in a database for monitoring
- **Web Dashboard**: Real-time monitoring UI with statistics and request history
- **Enhanced Logging**: Detailed logging of all requests and responses
- **Token Management**: Automatic token refresh when expired

## Installation

```bash
bun install
```

## Usage

### 1. Add Claude Accounts

Use the CLI to add your Claude accounts:

```bash
# Add a console.anthropic.com account
bun run cli.ts add one

# Add a claude.ai account
bun run cli.ts add two --mode max

# You get the idea...
```

Follow the prompts to authorize each account.

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
# Add a new account
bun cli.ts add <name> [--mode max|console]

# List all accounts
bun cli.ts list

# Remove an account
bun cli.ts remove <name>

# Reset usage statistics
bun cli.ts reset-stats

# Clear request history
bun cli.ts clear-history

# Show help
bun cli.ts help
```

## API Endpoints

- `GET /` - Web dashboard
- `GET /dashboard` - Web dashboard (alias)
- `GET /health` - Health check endpoint
- `GET /api/stats` - Get aggregated statistics
- `GET /api/accounts` - Get account information
- `GET /api/requests?limit=50` - Get recent requests
- `/v1/*` - Proxy to Anthropic API

## How It Works

1. **Request Distribution**: Incoming requests are distributed to accounts with the least usage
2. **Retry Logic**: Each account gets 3 retry attempts with exponential backoff:
   - 1st retry: 1 second delay
   - 2nd retry: 2 seconds delay
   - 3rd retry: 4 seconds delay
3. **Failover**: If all retries fail, moves to the next available account
4. **Token Management**: Access tokens are automatically refreshed when expired
5. **Request Tracking**: All requests are logged to a SQLite database with:
   - Request details (method, path, timestamp)
   - Account used
   - Response status and time
   - Failover attempts and retry count

## Dashboard Features

The web dashboard shows:
- **Total Requests**: Number of requests processed
- **Success Rate**: Percentage of successful requests
- **Active Accounts**: Number of configured accounts
- **Average Response Time**: Mean response time across all requests
- **Account Status**: List of accounts with usage stats and token validity
- **Request History**: Recent requests with details and status

The dashboard auto-refreshes every 5 seconds.

## Logging

The server logs all activity with timestamps:
- `INFO`: Normal operations, requests, and responses
- `WARN`: Failed requests that trigger failover
- `ERROR`: Critical errors and failures

## Database

The load balancer uses SQLite to store:
- Account information and tokens
- Request history and statistics

Database file: `claude-accounts.db`

## Configuration

You can modify retry behavior by editing these constants in `src/server.ts`:

```typescript
const RETRY_COUNT = 3        // Number of retries per account
const RETRY_DELAY_MS = 1000  // Initial delay between retries (milliseconds)
const RETRY_BACKOFF = 2      // Exponential backoff multiplier
```

## Environment Variables

- `PORT`: Server port (default: 8080)

## Requirements

- Bun runtime
- SQLite (included with Bun)

This project was created using `bun init` in bun v1.2.8. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.