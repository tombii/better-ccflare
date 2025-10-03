# Auto-Refresh Configuration Guide

This guide covers the auto-refresh feature in better-ccflare, which automatically sends dummy messages to Anthropic accounts when their usage windows reset to start a new window.

## Table of Contents

- [Overview](#overview)
- [How Auto-Refresh Works](#how-auto-refresh-works)
- [Setting Up Auto-Refresh](#setting-up-auto-refresh)
- [Configuration Examples](#configuration-examples)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [API Reference](#api-reference)

## Overview

The auto-refresh feature automatically starts new usage windows by:

- **Automatic Window Start**: Sends dummy messages when usage windows reset to start a new window
- **New Window Initialization**: Makes the first API call to begin the new rate limit window
- **API Integration**: Uses Anthropic's rate limit reset information for accurate timing
- **Per-Account Control**: Enable or disable auto-refresh on individual accounts
- **Transparent Operation**: Logs all refresh events for monitoring

### Key Benefits

1. **New Window Activation**: Automatically starts the new usage window when the previous one expires
2. **Window Initialization**: The first API call initializes the window's rate limit tracking
3. **Reduced Latency**: No waiting for the first real request to start the window
4. **Intelligent Scheduling**: Only starts new windows when the previous window has actually reset

## How Auto-Refresh Works

### The Refresh Process

1. **Window Monitoring**: The system tracks the `rate_limit_reset` timestamp from API responses
2. **Reset Detection**: Every minute, checks for accounts where `rate_limit_reset <= now` (window has expired)
3. **Window Expiration Check**: For each candidate account, checks if the stored `rate_limit_reset` from last refresh has expired
4. **Account Selection**: Only refreshes if the last refreshed window has expired or account was never refreshed
5. **Dummy Message**: A simple message is sent to start the new usage window
6. **Window Update**: The NEW `rate_limit_reset` from the API is stored (typically 5 hours in the future)
7. **Repeat**: Next refresh happens when that stored timestamp expires

### Algorithm Flow

```
Auto-Refresh Scheduler (runs every minute)
    ↓
Query: Find accounts where
  - auto_refresh_enabled = 1
  - paused = 0
  - provider = 'anthropic'
  - rate_limit_reset <= now (window has expired)
    ↓
For each candidate account:
    ↓
Check: Has this account been refreshed before?
  → NO: Refresh it (first time)
  → YES: Check if stored rate_limit_reset <= now
      → YES: Window has expired, refresh it
      → NO: Window still active, skip it
    ↓
Send dummy message (e.g., "Write a hello world program")
    ↓
Get NEW rate_limit_reset from API response (e.g., now + 5 hours)
    ↓
Update database: rate_limit_reset = new value
    ↓
Update tracking map: lastRefreshResetTime[account_id] = new value
    ↓
Next check: Will refresh again when new value expires (5 hours later)
```

### Dummy Messages

The system sends one of these simple messages to start the new usage window:
- "Write a hello world program in Python"
- "What is 2+2?"
- "Tell me a programmer joke"
- "What is the capital of France?"
- "Explain recursion in one sentence"

These messages use minimal tokens (max_tokens: 10) to minimize cost and usage impact.

## Setting Up Auto-Refresh

### Prerequisites

1. **Anthropic Account**: Auto-refresh only works with Anthropic accounts
2. **Valid Token**: Account must have a valid access token
3. **API Access**: Server must be running to enable auto-refresh

### Step-by-Step Setup

#### 1. Enable Auto-Refresh via Web Dashboard

The easiest way to enable auto-refresh is through the web dashboard:

1. Navigate to http://localhost:8080 (or your configured port)
2. Go to the "Accounts" tab
3. Find the account you want to enable auto-refresh for
4. Toggle the "Auto-refresh" switch next to the account name
5. The toggle will be enabled immediately

#### 2. Enable Auto-Refresh via API

```bash
# Get account ID
ACCOUNT_ID=$(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.name=="my-account") | .id')

# Enable auto-refresh
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-refresh \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

#### 3. Verify Configuration

```bash
# Check auto-refresh status
curl -s http://localhost:8080/api/accounts | \
  jq '.[] | {name, autoRefreshEnabled, rateLimitReset}'

# Monitor logs
tail -f ~/.local/share/better-ccflare/logs/better-ccflare.log | grep "Auto-refresh"
```

## Configuration Examples

### Example 1: Enable on Primary Account

Setup to keep your primary account always refreshed:

```bash
# Get primary account ID
PRIMARY_ID=$(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.name=="primary") | .id')

# Enable auto-refresh on primary account
curl -X POST http://localhost:8080/api/accounts/$PRIMARY_ID/auto-refresh \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

**Behavior:**
- New usage window starts immediately when previous window resets
- First API call made automatically to initialize the window
- Minimal delay when switching to this account

### Example 2: Combined with Auto-Fallback

Use both auto-refresh and auto-fallback for optimal availability:

```bash
# Get account ID
ACCOUNT_ID=$(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.name=="premium") | .id')

# Enable both auto-refresh and auto-fallback
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-refresh \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

**Behavior:**
- Auto-fallback switches back to this account when window resets
- Auto-refresh immediately starts the new window with a dummy message
- Seamless transition with the window already initialized

### Example 3: Selective Refresh

Enable auto-refresh only on high-priority accounts:

```bash
# Enable on accounts with priority < 10
for account in $(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.priority < 10) | .id'); do
  curl -X POST http://localhost:8080/api/accounts/$account/auto-refresh \
    -H "Content-Type: application/json" \
    -d '{"enabled": 1}'
done
```

**Behavior:**
- Only high-priority accounts are auto-refreshed
- Lower priority accounts save costs by not refreshing automatically
- Focus refresh activity on important accounts

## Best Practices

### 1. Account Selection

- **Enable on Critical Accounts**: Use auto-refresh for accounts that need their windows started immediately
- **Consider Costs**: Each refresh uses a small number of tokens (10 tokens per window start)
- **Monitor Usage**: Track refresh frequency in logs

### 2. Monitoring

```bash
# Monitor auto-refresh events in real-time
tail -f ~/.local/share/better-ccflare/logs/better-ccflare.log | grep "Auto-refresh"

# Check refresh status
watch -n 30 'curl -s http://localhost:8080/api/accounts | jq ".[] | select(.autoRefreshEnabled == true)"'

# Set up alerts for refresh failures
# (Example: Send notification when refresh fails)
```

### 3. Cost Optimization

- **Selective Enablement**: Only enable on accounts where immediate availability matters
- **Combine with Auto-Fallback**: Use together for optimal account switching
- **Monitor Refresh Frequency**: Each refresh consumes a small number of tokens

### 4. Safety Considerations

- **Test in Development**: Verify auto-refresh behavior before production use
- **Monitor Logs**: Watch for any unexpected refresh failures
- **Custom Endpoints**: Works with custom endpoint configurations

## Troubleshooting

### Common Issues

#### 1. Auto-Refresh Not Working

**Symptoms:**
- Account not being refreshed when window resets
- No refresh events in logs

**Solutions:**
```bash
# Check if auto-refresh is enabled
curl -s http://localhost:8080/api/accounts | jq '.[] | {name, autoRefreshEnabled, rateLimitReset}'

# Verify account is Anthropic provider
curl -s http://localhost:8080/api/accounts | jq '.[] | {name, provider, autoRefreshEnabled}'

# Check if account is paused
curl -s http://localhost:8080/api/accounts | jq '.[] | {name, paused, autoRefreshEnabled}'
```

#### 2. Refresh Failures

**Symptoms:**
- Refresh messages failing with errors
- Error messages in logs

**Solutions:**
- Check access token validity
- Verify custom endpoint is correct (if configured)
- Ensure account has not hit rate limits
- Check network connectivity

#### 3. Too Frequent Refreshes

**Symptoms:**
- Excessive refresh activity
- Too many refresh events in logs

**Solutions:**
- Verify `rate_limit_reset` timestamp is correct
- Check for clock synchronization issues
- Reduce number of accounts with auto-refresh enabled

### Debug Information

Enable debug logging to troubleshoot issues:

```bash
# Set debug environment variable
export LOG_LEVEL=DEBUG

# Restart server
better-ccflare

# Monitor detailed logs
tail -f ~/.local/share/better-ccflare/logs/better-ccflare.log | grep -E "(Auto-refresh|AutoRefreshScheduler)"
```

### Health Checks

Monitor system health with these endpoints:

```bash
# Check overall system health
curl http://localhost:8080/health

# Get statistics
curl http://localhost:8080/api/stats

# List all accounts with detailed status
curl http://localhost:8080/api/accounts
```

## API Reference

### Enable/Disable Auto-Refresh

```bash
# Enable auto-refresh
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-refresh \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

# Disable auto-refresh
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-refresh \
  -H "Content-Type: application/json" \
  -d '{"enabled": 0}'
```

### Account Information

```bash
# List all accounts
curl http://localhost:8080/api/accounts

# Get specific account
curl http://localhost:8080/api/accounts/{account-id}
```

### Response Format

Account response includes auto-refresh status:

```json
{
  "id": "account-uuid",
  "name": "my-account",
  "provider": "anthropic",
  "autoRefreshEnabled": true,
  "rateLimitStatus": "OK",
  "rateLimitReset": "2024-12-17T11:00:00.000Z",
  "paused": false
}
```

### Log Messages

Auto-refresh events are logged with these patterns:

```
[INFO] Starting auto-refresh scheduler
[INFO] Found 2 account(s) with reset windows for auto-refresh
[INFO] Sending auto-refresh message to account: my-account
[INFO] Auto-refresh message sent successfully for account: my-account
[INFO] Updated rate_limit_reset for my-account to 2024-12-17T11:00:00.000Z
[ERROR] Auto-refresh message failed for account my-account: 429 Too Many Requests
```

## Advanced Configuration

### Scheduler Configuration

The auto-refresh scheduler runs every minute by default. This is configured in the `AutoRefreshScheduler` class:

```typescript
private checkInterval = 60000; // Check every minute
```

### Custom Endpoint Support

Auto-refresh works with custom endpoint configurations:

```bash
# Set custom endpoint for account
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/custom-endpoint \
  -H "Content-Type: application/json" \
  -d '{"customEndpoint": "https://custom.api.endpoint/v1/messages"}'

# Enable auto-refresh (will use custom endpoint)
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-refresh \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

### Integration with Monitoring

Set up monitoring for auto-refresh events:

```bash
# Script to monitor and alert on auto-refresh
#!/bin/bash
while true; do
  if tail -n 10 ~/.local/share/better-ccflare/logs/better-ccflare.log | grep -q "Auto-refresh.*failed"; then
    echo "⚠️ Auto-refresh failed at $(date)"
    # Send notification (email, Slack, etc.)
  fi
  sleep 60
done
```

---

## Conclusion

The auto-refresh feature automatically starts new usage windows for your Anthropic accounts when their rate limit windows reset. By carefully configuring which accounts have auto-refresh enabled, you can achieve:

- **Automatic Window Initialization** when usage windows reset
- **Reduced Latency** by pre-starting windows before real requests
- **Window Tracking** ensuring rate limit windows are properly initialized
- **Optimal Resource Usage** through selective enablement

For questions or issues, refer to the [troubleshooting section](#troubleshooting) or check the main [documentation index](index.md).
