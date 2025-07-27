# Troubleshooting Guide

This guide helps you diagnose and resolve common issues with Claudeflare.

## Table of Contents

1. [OAuth Authentication Problems](#oauth-authentication-problems)
2. [Rate Limiting Issues](#rate-limiting-issues)
3. [Connection Problems](#connection-problems)
4. [Performance Issues](#performance-issues)
5. [Account Management Issues](#account-management-issues)
6. [Configuration Problems](#configuration-problems)
7. [Logging and Debugging](#logging-and-debugging)
8. [Common Error Messages](#common-error-messages)
9. [FAQ](#faq)
10. [Getting Help](#getting-help)

## OAuth Authentication Problems

### Invalid Tokens

**Symptom**: Requests fail with 401 Unauthorized errors

**Error Message**: `Failed to refresh token for account [name]: Unauthorized`

**Solutions**:
1. Check if the access token has expired:
   ```bash
   bun cli list
   ```
   Look for accounts with expired tokens (expires_at in the past)

2. Refresh the token manually:
   - Remove and re-add the account:
     ```bash
     bun cli remove <account-name>
     bun cli add <account-name>
     ```

3. Verify the refresh token is still valid in your Anthropic console

### Expired Tokens

**Symptom**: Token refresh attempts fail repeatedly

**Error Message**: `Token expired or missing for account: [name]`

**Solutions**:
1. Claudeflare automatically attempts to refresh expired tokens
2. If automatic refresh fails, re-authenticate the account
3. Check for refresh token stampede prevention - multiple simultaneous refresh attempts are prevented

### PKCE Failures

**Symptom**: OAuth authorization fails during account setup

**Error Messages**:
- `Exchange failed: Bad Request`
- `Invalid code_verifier`

**Solutions**:
1. Ensure you're using the complete authorization code including the state fragment (format: `code#state`)
2. Don't modify or truncate the authorization code
3. Complete the OAuth flow within the time limit (codes expire quickly)
4. Try the authorization flow again from the beginning

## Rate Limiting Issues

### Identifying Rate Limits

Claudeflare tracks several types of rate limits:

1. **Hard Rate Limits**: Block account usage
   - Status codes: `rate_limited`, `blocked`, `queueing_hard`, `payment_required`
   - HTTP 429 responses

2. **Soft Warnings**: Don't block usage
   - Status codes: `allowed_warning`, `queueing_soft`

**How to Check Rate Limit Status**:
```bash
# View account status including rate limits
bun cli list

# Check logs for rate limit messages
cat /tmp/claudeflare-logs/app.log | grep "rate limited"
```

### Recovery Strategies

**When an account is rate-limited**:
1. Claudeflare automatically rotates to the next available account
2. Rate-limited accounts are marked with a reset timestamp
3. Accounts automatically become available again after the reset time

**Manual recovery steps**:
1. Add more accounts to your pool:
   ```bash
   bun cli add account2
   ```

2. Check rate limit reset times in the dashboard:
   ```
   http://localhost:8080/dashboard
   ```

3. Temporarily pause rate-limited accounts:
   ```bash
   # This prevents the account from being selected
   bun cli pause <account-name>
   ```

## Connection Problems

### Network Timeouts

**Symptom**: Requests hang or timeout

**Error Messages**:
- `ECONNREFUSED`
- `ETIMEDOUT`
- `Error forwarding request`

**Solutions**:
1. Check your internet connection
2. Verify the Anthropic API is accessible:
   ```bash
   curl -I https://api.anthropic.com/v1/messages
   ```
3. Check proxy settings if behind a corporate firewall
4. Increase retry configuration in config file

### Proxy Configuration

**Configuring HTTP proxy**:
```bash
# Set proxy environment variables before starting
export HTTP_PROXY=http://proxy.company.com:8080
export HTTPS_PROXY=http://proxy.company.com:8080
bun start
```

**Bypass proxy for local requests**:
```bash
export NO_PROXY=localhost,127.0.0.1
```

## Performance Issues

### Slow Responses

**Symptoms**:
- High response times in logs
- Dashboard shows increased latency

**Solutions**:
1. Check account distribution:
   - Ensure accounts aren't all rate-limited
   - Verify load balancing strategy is appropriate

2. Optimize retry settings:
   ```json
   {
     "retry_attempts": 2,
     "retry_delay_ms": 500,
     "retry_backoff": 1.5
   }
   ```

3. Use session-based routing for conversational workloads:
   ```bash
   # Set strategy to session for better performance with conversations
   bun cli config set lb_strategy session
   ```

### High Memory Usage

**Symptom**: Process consuming excessive memory

**Solutions**:
1. Check log file size (auto-rotates at 10MB):
   ```bash
   ls -lh /tmp/claudeflare-logs/app.log
   ```

2. Clear request history:
   ```bash
   bun cli clear-history
   ```

3. Restart the server to clear in-memory caches:
   ```bash
   # Graceful shutdown with Ctrl+C
   # Then restart
   bun start
   ```

## Account Management Issues

### Account Not Being Used

**Symptom**: Specific account never receives requests

**Check**:
1. Account status:
   ```bash
   bun cli list
   # Look for: paused, rate_limited, or expired
   ```

2. Account tier and weight (for weighted strategies):
   - Higher tier accounts get more requests
   - Check account_tier in the database

**Solutions**:
1. Unpause the account if paused
2. Wait for rate limit to reset
3. Re-add the account if expired

### Account Selection Problems

**Symptom**: Uneven distribution of requests

**Solutions**:
1. Check current strategy:
   ```bash
   bun cli config get lb_strategy
   ```

2. Choose appropriate strategy:
   - `round-robin`: Equal distribution
   - `weighted`: Based on account tier
   - `least-requests`: Least used account first
   - `session`: Sticky sessions for conversations

## Configuration Problems

### Config File Location

Default locations by platform:
- **macOS**: `~/Library/Application Support/claudeflare/config.json`
- **Linux**: `~/.config/claudeflare/config.json`
- **Windows**: `%APPDATA%\claudeflare\config.json`

### Invalid Configuration

**Symptom**: Server fails to start or uses default values

**Error Messages**:
- `Failed to parse config file`
- `Invalid strategy: [name]`

**Solutions**:
1. Validate JSON syntax:
   ```bash
   cat ~/.config/claudeflare/config.json | jq .
   ```

2. Reset to defaults:
   ```bash
   # Backup current config
   cp ~/.config/claudeflare/config.json ~/.config/claudeflare/config.backup.json
   # Remove corrupted config
   rm ~/.config/claudeflare/config.json
   # Restart server to create new config
   bun start
   ```

### Environment Variable Override

Environment variables override config file settings:
- `CLIENT_ID`: OAuth client ID
- `PORT`: Server port (default: 8080)
- `LB_STRATEGY`: Load balancing strategy
- `RETRY_ATTEMPTS`: Number of retry attempts
- `RETRY_DELAY_MS`: Initial retry delay
- `SESSION_DURATION_MS`: Session duration for session strategy

## Logging and Debugging

### Log File Locations

Logs are stored in the system's temporary directory:
- **Default**: `/tmp/claudeflare-logs/app.log` (Unix-like systems)
- **Windows**: `%TEMP%\claudeflare-logs\app.log`

### Enabling Debug Mode

**Method 1: Environment Variable**
```bash
export CLAUDEFLARE_DEBUG=1
export LOG_LEVEL=DEBUG
bun start
```

**Method 2: Verbose Logging**
```bash
# View real-time logs
tail -f /tmp/claudeflare-logs/app.log
```

### Log Formats

**JSON Format** (for parsing):
```bash
export LOG_FORMAT=json
bun start
```

**Pretty Format** (default):
```
[2024-01-20T10:30:45.123Z] INFO: [Proxy] Request completed for account1: 200 in 1234ms
```

### Reading Logs

**Filter by log level**:
```bash
# View only errors
grep "ERROR" /tmp/claudeflare-logs/app.log

# View warnings and errors
grep -E "WARN|ERROR" /tmp/claudeflare-logs/app.log
```

**Filter by component**:
```bash
# View only proxy logs
grep "\[Proxy\]" /tmp/claudeflare-logs/app.log

# View only server logs
grep "\[Server\]" /tmp/claudeflare-logs/app.log
```

## Common Error Messages

### "No active accounts available"

**Meaning**: All accounts are either paused, rate-limited, or expired

**Solution**: 
- Add new accounts or wait for rate limits to reset
- Requests will be forwarded without authentication (may fail)

### "Provider cannot handle this request path"

**Meaning**: Request path doesn't match expected Anthropic API patterns

**Solution**: 
- Ensure requests are to `/v1/*` endpoints
- Check if you're using the correct base URL

### "All accounts failed to proxy the request"

**Meaning**: Every account attempted but all failed

**Response**:
```json
{
  "error": "All accounts failed to proxy the request",
  "attempts": 3,
  "lastError": "Error message here"
}
```

**Solutions**:
1. Check individual account errors in logs
2. Verify network connectivity
3. Ensure at least one account has valid credentials

### "Failed to refresh token: Exchange failed"

**Meaning**: OAuth token exchange failed during refresh

**Solutions**:
1. Check if the refresh token was revoked
2. Re-authenticate the account
3. Verify client_id is correct

## FAQ

### Q: How do I know if Claudeflare is working?

**A**: Check the health endpoint:
```bash
curl http://localhost:8080/health
```

Expected response:
```json
{
  "status": "ok",
  "accounts": {
    "total": 3,
    "active": 2,
    "paused": 1
  },
  "uptime": 3600000
}
```

### Q: Can I use Claudeflare with multiple client applications?

**A**: Yes, Claudeflare acts as a transparent proxy. Point any Claude API client to `http://localhost:8080` instead of `https://api.anthropic.com`.

### Q: How do I backup my accounts?

**A**: The account data is stored in the SQLite database. Backup locations:
- **macOS**: `~/Library/Application Support/claudeflare/claudeflare.db`
- **Linux**: `~/.local/share/claudeflare/claudeflare.db`
- **Windows**: `%LOCALAPPDATA%\claudeflare\claudeflare.db`

### Q: What happens during a graceful shutdown?

**A**: When receiving SIGINT (Ctrl+C) or SIGTERM:
1. Stops accepting new requests
2. Waits for in-flight requests to complete
3. Closes database connections
4. Flushes logs to disk

### Q: How do I migrate to a new machine?

**A**: Copy these files to the new machine:
1. Database file (`claudeflare.db`)
2. Config file (`config.json`)
3. Set the same CLIENT_ID environment variable

## Getting Help

### Reporting Bugs

When reporting issues, include:

1. **System Information**:
   ```bash
   bun --version
   node --version
   echo $OSTYPE
   ```

2. **Error Logs**:
   ```bash
   # Last 100 lines of logs
   tail -n 100 /tmp/claudeflare-logs/app.log
   ```

3. **Configuration** (sanitized):
   ```bash
   # Remove sensitive data before sharing
   cat ~/.config/claudeflare/config.json | jq 'del(.client_id)'
   ```

4. **Steps to Reproduce**:
   - Exact commands run
   - Expected behavior
   - Actual behavior

### Debug Information Script

Save this as `debug-info.sh`:
```bash
#!/bin/bash
echo "=== Claudeflare Debug Info ==="
echo "Date: $(date)"
echo "System: $(uname -a)"
echo "Bun Version: $(bun --version)"
echo ""
echo "=== Process Info ==="
ps aux | grep -E "bun start|claudeflare" | grep -v grep
echo ""
echo "=== Port Check ==="
lsof -i :8080 2>/dev/null || echo "Port 8080 not in use"
echo ""
echo "=== Recent Errors ==="
grep "ERROR" /tmp/claudeflare-logs/app.log | tail -10
echo ""
echo "=== Account Status ==="
bun cli list 2>/dev/null || echo "Could not get account list"
```

### Community Support

- Check existing issues in the repository
- Review this troubleshooting guide
- Search logs for specific error messages
- Try running in debug mode for more details

### Performance Monitoring

Monitor key metrics via the dashboard API:
```bash
# Get current stats
curl http://localhost:8080/api/stats

# Get request history
curl http://localhost:8080/api/requests?limit=10

# Get analytics
curl http://localhost:8080/api/analytics?range=1h
```

Remember: Most issues can be resolved by checking logs, verifying account status, and ensuring proper network connectivity.