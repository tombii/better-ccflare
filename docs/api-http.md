# Claudeflare HTTP API Documentation

## Quick Start

```bash
# Check health status
curl http://localhost:8080/health

# Proxy a request to Claude
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-opus-20240229",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'

# List all accounts
curl http://localhost:8080/api/accounts

# View dashboard
open http://localhost:8080/dashboard
```

## Overview

Claudeflare provides a RESTful HTTP API for managing accounts, monitoring usage, and proxying requests to Claude. The API runs on port 8080 by default and requires no authentication.

### Base URL

```
http://localhost:8080
```

### Content Type

All API responses are in JSON format with `Content-Type: application/json`.

## Endpoints

### Health Check

#### GET /health

Check the health status of the Claudeflare service.

**Response:**
```json
{
  "status": "ok",
  "accounts": 5,
  "timestamp": "2024-12-17T10:30:45.123Z",
  "strategy": "round-robin"
}
```

**Example:**
```bash
curl http://localhost:8080/health
```

---

### Claude Proxy

#### /v1/* (All Methods)

Proxy requests to Claude API. All requests to paths starting with `/v1/` are forwarded to Claude using the configured load balancing strategy. This includes POST, GET, and any other HTTP methods that Claude's API supports.

**Supported Endpoints:**
- `POST /v1/messages` - Create chat completions
- `POST /v1/complete` - Text completion (legacy)
- Any other Claude API v1 endpoint

**Note:** There is no `/v1/models` endpoint provided by Claudeflare. Model listing would need to be done directly through Claude's API if such an endpoint exists.

**Headers:**
- All standard Claude API headers are supported
- `Authorization` header is managed by Claudeflare (no need to provide)

**Request Body:**
Same as Claude API requirements for the specific endpoint.

**Response:**
Proxied response from Claude API, including streaming responses.

**Automatic Failover:**
If a request fails or an account is rate limited, Claudeflare automatically retries with the next available account according to the configured load balancing strategy. This ensures high availability and reliability.

**Example:**
```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-opus-20240229",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

---

### Account Management

#### GET /api/accounts

List all configured accounts with their current status.

**Response:**
```json
[
  {
    "id": "uuid-here",
    "name": "account1",
    "provider": "anthropic",
    "requestCount": 150,
    "totalRequests": 1500,
    "lastUsed": "2024-12-17T10:25:30.123Z",
    "created": "2024-12-01T08:00:00.000Z",
    "tier": 5,
    "paused": false,
    "tokenStatus": "valid",
    "rateLimitStatus": "allowed_warning (5m)",
    "rateLimitReset": "2024-12-17T10:30:00.000Z",
    "rateLimitRemaining": 100,
    "sessionInfo": "Active: 25 reqs"
  }
]
```

**Example:**
```bash
curl http://localhost:8080/api/accounts
```

#### POST /api/accounts

Add a new account using OAuth flow.

**Step 1: Initialize OAuth**

**Request:**
```json
{
  "name": "myaccount",
  "mode": "max",  // "max" or "console"
  "tier": 5,      // 1, 5, or 20
  "step": "init"
}
```

**Response:**
```json
{
  "success": true,
  "authUrl": "https://console.anthropic.com/oauth/authorize?...",
  "step": "authorize"
}
```

**Step 2: Complete OAuth**

**Request:**
```json
{
  "name": "myaccount",
  "code": "authorization-code-from-oauth",
  "step": "callback"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Account 'myaccount' added successfully!",
  "mode": "Claude Max",
  "tier": 5
}
```

**Example:**
```bash
# Step 1: Initialize
curl -X POST http://localhost:8080/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"name": "myaccount", "mode": "max", "tier": 5, "step": "init"}'

# Step 2: After OAuth authorization
curl -X POST http://localhost:8080/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"name": "myaccount", "code": "auth-code", "step": "callback"}'
```

#### DELETE /api/accounts/:accountId

Remove an account. Requires confirmation.

**Request:**
```json
{
  "confirm": "account-name"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Account 'account-name' removed successfully"
}
```

**Example:**
```bash
curl -X DELETE http://localhost:8080/api/accounts/uuid-here \
  -H "Content-Type: application/json" \
  -d '{"confirm": "myaccount"}'
```

#### POST /api/accounts/:accountId/tier

Update account tier.

**Request:**
```json
{
  "tier": 5  // 1, 5, or 20
}
```

**Response:**
```json
{
  "success": true,
  "tier": 5
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/accounts/uuid-here/tier \
  -H "Content-Type: application/json" \
  -d '{"tier": 20}'
```

#### POST /api/accounts/:accountId/pause

Pause an account temporarily.

**Response:**
```json
{
  "success": true,
  "message": "Account 'myaccount' paused"
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/accounts/uuid-here/pause
```

#### POST /api/accounts/:accountId/resume

Resume a paused account.

**Response:**
```json
{
  "success": true,
  "message": "Account 'myaccount' resumed"
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/accounts/uuid-here/resume
```

---

### Statistics

#### GET /api/stats

Get overall usage statistics.

**Response:**
```json
{
  "totalRequests": 5000,
  "successRate": 98.5,
  "activeAccounts": 4,
  "avgResponseTime": 1250.5,
  "totalTokens": 1500000,
  "totalCostUsd": 125.50,
  "topModels": [
    {"model": "claude-3-opus-20240229", "count": 3000},
    {"model": "claude-3-sonnet-20240229", "count": 2000}
  ]
}
```

**Example:**
```bash
curl http://localhost:8080/api/stats
```

#### POST /api/stats/reset

Reset all usage statistics.

**Response:**
```json
{
  "success": true,
  "message": "Statistics reset successfully"
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/stats/reset
```

---

### Request History

#### GET /api/requests

Get recent request summary.

**Query Parameters:**
- `limit` - Number of requests to return (default: 50)

**Response:**
```json
[
  {
    "id": "request-uuid",
    "timestamp": "2024-12-17T10:30:45.123Z",
    "method": "POST",
    "path": "/v1/messages",
    "accountUsed": "account1",
    "statusCode": 200,
    "success": true,
    "errorMessage": null,
    "responseTimeMs": 1234,
    "failoverAttempts": 0,
    "model": "claude-3-opus-20240229",
    "promptTokens": 50,
    "completionTokens": 100,
    "totalTokens": 150,
    "inputTokens": 50,
    "outputTokens": 100,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0,
    "costUsd": 0.0125
  }
]
```

**Example:**
```bash
curl "http://localhost:8080/api/requests?limit=100"
```

#### GET /api/requests/detail

Get detailed request information including payloads.

**Query Parameters:**
- `limit` - Number of requests to return (default: 100)

**Response:**
```json
[
  {
    "id": "request-uuid",
    "timestamp": "2024-12-17T10:30:45.123Z",
    "method": "POST",
    "path": "/v1/messages",
    "accountUsed": "account1",
    "statusCode": 200,
    "success": true,
    "payload": {
      "request": {
        "headers": {...},
        "body": "base64-encoded-body"
      },
      "response": {
        "status": 200,
        "headers": {...},
        "body": "base64-encoded-body"
      },
      "meta": {
        "accountId": "uuid",
        "timestamp": 1234567890,
        "success": true,
        "isStream": false,
        "bodyTruncated": false
      }
    }
  }
]
```

**Example:**
```bash
curl "http://localhost:8080/api/requests/detail?limit=10"
```

---

### Configuration

#### GET /api/config

Get current configuration.

**Response:**
```json
{
  "lb_strategy": "round-robin",
  "port": 8080,
  "sessionDurationMs": 18000000
}
```

**Example:**
```bash
curl http://localhost:8080/api/config
```

#### GET /api/config/strategy

Get current load balancing strategy.

**Response:**
```json
{
  "strategy": "round-robin"
}
```

**Example:**
```bash
curl http://localhost:8080/api/config/strategy
```

#### POST /api/config/strategy

Update load balancing strategy.

**Request:**
```json
{
  "strategy": "weighted-round-robin"
}
```

**Response:**
```json
{
  "success": true,
  "strategy": "weighted-round-robin"
}
```

**Available Strategies:**
- `round-robin` - Simple round-robin distribution
- `weighted-round-robin` - Round-robin weighted by account tier
- `least-requests` - Route to account with fewest requests
- `session` - Sticky sessions for consistent routing
- `weighted` - Weighted by tier and usage

**Example:**
```bash
curl -X POST http://localhost:8080/api/config/strategy \
  -H "Content-Type: application/json" \
  -d '{"strategy": "session"}'
```

#### GET /api/strategies

List all available load balancing strategies.

**Response:**
```json
[
  {
    "name": "round-robin",
    "description": "Simple round-robin load balancing"
  },
  {
    "name": "weighted-round-robin",
    "description": "Round-robin weighted by account tier"
  },
  {
    "name": "least-requests",
    "description": "Route to account with least requests"
  },
  {
    "name": "session",
    "description": "Sticky sessions for consistent routing"
  },
  {
    "name": "weighted",
    "description": "Weighted by tier and current usage"
  }
]
```

**Example:**
```bash
curl http://localhost:8080/api/strategies
```

---

### Analytics

#### GET /api/analytics

Get detailed analytics data.

**Query Parameters:**
- `range` - Time range: `1h`, `6h`, `24h`, `7d`, `30d` (default: `24h`)
- `accounts` - Filter by account names (comma-separated list)
- `models` - Filter by model names (comma-separated list)
- `status` - Filter by request status: `all`, `success`, `error` (default: `all`)

**Response:**
```json
{
  "totals": {
    "requests": 5000,
    "successRate": 98.5,
    "activeAccounts": 4,
    "avgResponseTime": 1250.5,
    "totalTokens": 1500000,
    "totalCostUsd": 125.50
  },
  "timeSeries": [
    {
      "ts": 1734430800000,
      "requests": 100,
      "tokens": 15000,
      "costUsd": 1.25,
      "successRate": 98,
      "errorRate": 2,
      "cacheHitRate": 15,
      "avgResponseTime": 1200
    }
  ],
  "tokenBreakdown": {
    "inputTokens": 500000,
    "cacheReadInputTokens": 100000,
    "cacheCreationInputTokens": 50000,
    "outputTokens": 850000
  },
  "modelDistribution": [
    {"model": "claude-3-opus-20240229", "count": 3000}
  ],
  "accountPerformance": [
    {"name": "account1", "requests": 2500, "successRate": 99}
  ],
  "costByModel": [
    {"model": "claude-3-opus-20240229", "costUsd": 100.50, "requests": 3000}
  ],
  "modelPerformance": [
    {
      "model": "claude-3-opus-20240229",
      "avgResponseTime": 1300,
      "p95ResponseTime": 2500,
      "errorRate": 1.5
    }
  ]
}
```

**Examples:**
```bash
# Basic analytics for last 7 days
curl "http://localhost:8080/api/analytics?range=7d"

# Analytics filtered by specific accounts
curl "http://localhost:8080/api/analytics?range=24h&accounts=account1,account2"

# Analytics for specific models with success status only
curl "http://localhost:8080/api/analytics?range=24h&models=claude-3-opus-20240229,claude-3-sonnet-20240229&status=success"

# Combined filters
curl "http://localhost:8080/api/analytics?range=7d&accounts=premium1,premium2&models=claude-3-opus-20240229&status=error"
```

---

### Logs

#### GET /api/logs/stream

Stream real-time logs via Server-Sent Events (SSE).

**Response:** SSE stream with log events

**Example:**
```bash
curl -N http://localhost:8080/api/logs/stream
```

#### GET /api/logs/history

Get historical logs.

**Response:**
```json
[
  {
    "timestamp": "2024-12-17T10:30:45.123Z",
    "level": "info",
    "component": "proxy",
    "message": "Request completed",
    "metadata": {...}
  }
]
```

**Example:**
```bash
curl http://localhost:8080/api/logs/history
```

---

## Error Handling

All API errors follow a consistent format:

```json
{
  "error": "Error message",
  "details": {
    // Optional additional error details
  }
}
```

### Common Status Codes

- **200 OK** - Request successful
- **400 Bad Request** - Invalid request parameters
- **404 Not Found** - Resource not found
- **429 Too Many Requests** - Rate limited
- **500 Internal Server Error** - Server error
- **502 Bad Gateway** - Upstream provider error
- **503 Service Unavailable** - All accounts failed

### Rate Limiting

When an account hits rate limits, Claudeflare automatically fails over to the next available account. If all accounts are rate limited, a 503 error is returned.

Rate limit information is included in account responses:
- `rateLimitStatus` - Current status (e.g., "allowed", "allowed_warning", "rate_limited")
- `rateLimitReset` - When the rate limit resets
- `rateLimitRemaining` - Remaining requests (if available)

---

## Streaming Responses

The proxy endpoints support streaming responses for compatible Claude API calls. When making a streaming request:

1. Include `"stream": true` in your request body
2. The response will be `Content-Type: text/event-stream`
3. Each chunk is delivered as a Server-Sent Event

**Streaming Response Capture:**
Claudeflare automatically captures streaming response bodies for analytics and debugging purposes:
- Captured data is limited to `CF_STREAM_BODY_MAX_BYTES` (default: 256KB)
- The capture process doesn't interfere with the client's stream
- Captured bodies are stored base64-encoded in the request history
- If the response exceeds the size limit, it's marked as truncated in metadata

**Example:**
```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-opus-20240229",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "max_tokens": 100,
    "stream": true
  }'
```

---

## Dashboard

A web dashboard is available at:

```
http://localhost:8080/dashboard
http://localhost:8080/          # Redirects to /dashboard
```

The dashboard provides a visual interface for:
- Monitoring account status and usage
- Viewing real-time analytics
- Managing configuration
- Examining request history

---

## Configuration

### Environment Variables

Claudeflare can be configured using the following environment variables:

- `PORT` - Server port (default: 8080)
- `LB_STRATEGY` - Load balancing strategy (default: round-robin)
- `SESSION_DURATION_MS` - Session duration in milliseconds (default: 18000000 / 5 hours)
- `CLIENT_ID` - OAuth client ID for Anthropic authentication (default: 9d1c250a-e61b-44d9-88ed-5944d1962f5e)
- `CF_STREAM_BODY_MAX_BYTES` - Maximum bytes to capture from streaming responses (default: 262144 / 256KB)
- `RETRY_ATTEMPTS` - Number of retry attempts for failed requests (default: 3)
- `RETRY_DELAY_MS` - Initial delay between retries in milliseconds (default: 1000)
- `RETRY_BACKOFF` - Exponential backoff multiplier for retries (default: 2)

### Configuration File

In addition to environment variables, Claudeflare supports configuration through a JSON file. The config file location varies by platform:
- macOS: `~/Library/Application Support/claudeflare/config.json`
- Linux: `~/.config/claudeflare/config.json`
- Windows: `%APPDATA%\claudeflare\config.json`

**Supported Configuration Keys:**
```json
{
  "lb_strategy": "round-robin",
  "client_id": "your-oauth-client-id",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080,
  "stream_body_max_bytes": 262144
}
```

**Note:** Environment variables take precedence over config file settings.

### Load Balancing Strategies

The following strategies are available:
- `round-robin` - Simple round-robin distribution
- `weighted-round-robin` - Round-robin weighted by account tier
- `least-requests` - Route to account with fewest requests  
- `session` - Sticky sessions for consistent routing
- `weighted` - Weighted by tier and current usage

## Notes

1. **No Authentication**: The API endpoints do not require authentication. Claudeflare manages the OAuth tokens internally for proxying to Claude.

2. **Automatic Failover**: When a request fails or an account is rate limited, Claudeflare automatically tries the next available account. If no accounts are available, requests are forwarded without authentication as a fallback.

3. **Token Refresh**: Access tokens are automatically refreshed when they expire.

4. **Request Logging**: All requests are logged with detailed metrics including tokens used, cost, and response times. Database writes are performed asynchronously to avoid blocking request processing.

5. **Account Tiers**: Accounts can have different tiers (1, 5, or 20) which affect their weight in certain load balancing strategies.

6. **Session Affinity**: The "session" strategy maintains sticky sessions for consistent routing within a time window.

7. **Rate Limit Tracking**: Rate limit information is automatically extracted from responses and stored for each account, including reset times and remaining requests.

8. **Provider Filtering**: Accounts are automatically filtered by provider when selecting for requests, ensuring compatibility.