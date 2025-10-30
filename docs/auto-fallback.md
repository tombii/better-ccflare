# Auto-Fallback Configuration Guide

This guide covers the auto-fallback feature in better-ccflare, which allows automatic switching back to higher priority accounts when their usage windows reset.

## Table of Contents

- [Overview](#overview)
- [How Auto-Fallback Works](#how-auto-fallback-works)
- [Setting Up Auto-Fallback](#setting-up-auto-fallback)
- [Configuration Examples](#configuration-examples)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [API Reference](#api-reference)

## Overview

The auto-fallback feature provides intelligent automatic account management by:

- **Automatic Recovery**: Switches back to preferred accounts when they become available
- **Priority-Based Selection**: Respects your account priority configuration
- **API Integration**: Uses Anthropic's rate limit reset information for accurate timing
- **Per-Account Control**: Enable or disable auto-fallback on individual accounts
- **Transparent Operation**: Logs all fallback events for monitoring

### Key Benefits

1. **Cost Optimization**: Automatically use free or lower-cost accounts when available
2. **Performance Maximization**: Ensure highest-priority accounts are used whenever possible
3. **Reduced Manual Intervention**: No need to manually switch accounts when rate limits reset
4. **Intelligent Load Balancing**: Accounts are used according to your priority preferences

## How Auto-Fallback Works

### The Detection Process

1. **Rate Limit Monitoring**: The system tracks the `rate_limit_reset` timestamp from API responses
2. **Window Reset Detection**: When `rate_limit_reset <= now`, the usage window has reset
3. **Priority Evaluation**: Accounts are evaluated based on priority (lower number = higher priority)
4. **Auto-Fallback Check**: Only accounts with `auto_fallback_enabled = true` are considered
5. **Automatic Switching**: The highest priority available account with auto-fallback enabled is selected

### Algorithm Flow

```
Incoming Request
    ↓
Check for Auto-Fallback Candidates
    ↓
Filter: auto_fallback_enabled = true
    ↓
Filter: not paused
    ↓
Filter: rate_limit_reset <= now (window reset)
    ↓
Filter: not rate_limited (or rate_limit expired)
    ↓
Sort by priority (ascending)
    ↓
Select highest priority candidate
    ↓
If found → Use auto-fallback account
    ↓
If not found → Continue with normal session strategy
```

### Integration with Session Strategy

Auto-fallback integrates seamlessly with the existing session-based load balancing:

- **Pre-check**: Auto-fallback is checked before session management
- **Session Reset**: When switching via auto-fallback, a new session is started
- **Logging**: All auto-fallback events are logged for transparency
- **Fallback Safety**: If auto-fallback fails, normal fallback mechanisms apply

## Setting Up Auto-Fallback

### Prerequisites

1. **Multiple Accounts**: You need at least 2 accounts configured
2. **Priority Configuration**: Accounts should have different priorities for meaningful fallback
3. **API Access**: Server must be running to access the auto-fallback endpoints

### Step-by-Step Setup

#### 1. Configure Account Priorities

```bash
# Add accounts with different priorities
better-ccflare --add-account primary --mode max --priority 0
better-ccflare --add-account secondary --mode max --priority 10
better-ccflare --add-account backup --mode console --priority 50
```

#### 2. Enable Auto-Fallback on Preferred Accounts

```bash
# Get account ID
ACCOUNT_ID=$(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.name=="primary") | .id')

# Enable auto-fallback
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

#### 3. Verify Configuration

```bash
# Check auto-fallback status
curl -s http://localhost:8080/api/accounts | \
  jq '.[] | {name, priority, autoFallbackEnabled, rateLimitStatus}'

# Monitor logs
tail -f ~/.local/share/better-ccflare/logs/better-ccflare.log | grep "Auto-fallback"
```

### Configuration Script

Here's a complete script to set up auto-fallback:

```bash
#!/bin/bash
# Auto-fallback setup script

set -e

API_BASE="http://localhost:8080/api"

echo "Setting up auto-fallback configuration..."

# Add accounts (if they don't exist)
better-ccflare --add-account primary --mode max --priority 0 || true
better-ccflare --add-account secondary --mode max --priority 10 || true
better-ccflare --add-account backup --mode console --priority 50 || true

# Get account IDs
PRIMARY_ID=$(curl -s "$API_BASE/accounts" | jq -r '.[] | select(.name=="primary") | .id')
SECONDARY_ID=$(curl -s "$API_BASE/accounts" | jq -r '.[] | select(.name=="secondary") | .id')

# Enable auto-fallback on primary account
curl -X POST "$API_BASE/accounts/$PRIMARY_ID/auto-fallback" \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

echo "✅ Auto-fallback enabled for primary account"
echo "✅ Configuration complete!"
echo ""
echo "Account priorities:"
echo "- Primary (priority 0): auto-fallback enabled"
echo "- Secondary (priority 10): standard fallback"
echo "- Backup (priority 50): emergency use"
```

## Configuration Examples

### Example 1: Cost Optimization

Setup to minimize costs by preferring free accounts:

```bash
# High priority account (auto-fallback enabled)
better-ccflare --add-account high-priority --mode console --priority 0

# Lower priority accounts
better-ccflare --add-account medium-priority --mode max --priority 10
better-ccflare --add-account low-priority --mode max --priority 20

# Enable auto-fallback on high priority account
ACCOUNT_ID=$(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.name=="high-priority") | .id')
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

**Behavior:**
- High priority account is used whenever available
- Automatically switches back to high priority account when its rate limit resets
- Lower priority accounts only used when high priority account is rate limited

### Example 2: Performance Maximization

Setup to prioritize highest performance accounts:

```bash
# High priority account (highest performance, priority 0)
better-ccflare --add-account premium --mode max --priority 0

# Medium priority account (good performance, priority 10)
better-ccflare --add-account standard --mode max --priority 10

# Low priority account (lower performance, priority 20)
better-ccflare --add-account basic --mode console --priority 20

# Enable auto-fallback on premium account
ACCOUNT_ID=$(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.name=="premium") | .id')
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

**Behavior:**
- Premium account gets priority usage when available
- Automatic fallback to premium when rate limits reset
- Standard and basic accounts used as fallbacks

### Example 3: Business Hours Configuration

Setup for different usage patterns during business vs after hours:

```bash
# High priority account (priority 0)
better-ccflare --add-account business --mode max --priority 0

# Medium priority account (priority 10)
better-ccflare --add-account after-hours --mode max --priority 10

# Low priority account (priority 20)
better-ccflare --add-account weekend --mode console --priority 20

# Enable auto-fallback on business account
ACCOUNT_ID=$(curl -s http://localhost:8080/api/accounts | jq -r '.[] | select(.name=="business") | .id')
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'
```

**Behavior:**
- Business account automatically recovers when rate limits reset during business hours
- Other accounts provide coverage during high-usage periods

## Best Practices

### 1. Priority Configuration

- **Use Clear Gaps**: Assign priorities with clear gaps (0, 10, 20) for future additions
- **Document Priorities**: Keep a record of your priority scheme
- **Test Thoroughly**: Verify auto-fallback behavior with test requests

### 2. Monitoring

```bash
# Monitor auto-fallback events in real-time
tail -f ~/.local/share/better-ccflare/logs/better-ccflare.log | grep "Auto-fallback"

# Check account status periodically
watch -n 30 'curl -s http://localhost:8080/api/accounts | jq ".[] | select(.autoFallbackEnabled == true)"'

# Set up alerts for auto-fallback events
# (Example: Send notification when auto-fallback triggers)
```

### 3. Performance Optimization

- **Enable on High-Value Accounts**: Only enable auto-fallback on accounts you want to prioritize
- **Consider Rate Limits**: Accounts with lower rate limits may trigger frequent fallbacks
- **Monitor Costs**: Auto-fallback may increase usage of higher-priority accounts

### 4. Safety Considerations

- **Test in Development**: Verify auto-fallback behavior in development before production
- **Have Fallbacks**: Ensure you have adequate fallback accounts
- **Monitor for Errors**: Watch for any unexpected account switching behavior

## Troubleshooting

### Common Issues

#### 1. Auto-Fallback Not Triggering

**Symptoms:**
- Higher priority account with auto-fallback enabled is not being used
- System continues using lower priority account

**Solutions:**
```bash
# Check if auto-fallback is enabled
curl -s http://localhost:8080/api/accounts | jq '.[] | {name, autoFallbackEnabled, rateLimitReset, rateLimitStatus}'

# Verify rate limit reset time
curl -s http://localhost:8080/api/accounts | jq '.[] | {name, rateLimitReset, rate_limited_until}'

# Check account priorities
curl -s http://localhost:8080/api/accounts | jq '.[] | {name, priority}'
```

#### 2. Excessive Account Switching

**Symptoms:**
- Frequent switching between accounts
- Too many auto-fallback events in logs

**Solutions:**
- Reduce the number of accounts with auto-fallback enabled
- Adjust priorities to reduce conflicts
- Consider increasing session duration

#### 3. Rate Limit Issues

**Symptoms:**
- Accounts getting rate limited frequently
- Auto-fallback not preventing rate limits

**Solutions:**
- Check account priorities and rate limits
- Distribute load more evenly across accounts
- Consider disabling auto-fallback on frequently rate-limited accounts

### Debug Information

Enable debug logging to troubleshoot issues:

```bash
# Set debug environment variable
export LOG_LEVEL=DEBUG

# Restart server
better-ccflare

# Monitor detailed logs
tail -f ~/.local/share/better-ccflare/logs/better-ccflare.log | grep -E "(Auto-fallback|SessionStrategy|Account)"
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

### Enable/Disable Auto-Fallback

```bash
# Enable auto-fallback
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

# Disable auto-fallback
curl -X POST http://localhost:8080/api/accounts/{account-id}/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 0}'
```

### Account Information

```bash
# List all accounts
curl http://localhost:8080/api/accounts

# Get specific account
curl http://localhost:8080/api/accounts/{account-id}

# Update account priority
curl -X POST http://localhost:8080/api/accounts/{account-id}/priority \
  -H "Content-Type: application/json" \
  -d '{"priority": 5}'
```

### Response Format

Account response includes auto-fallback status:

```json
{
  "id": "account-uuid",
  "name": "primary-account",
  "provider": "anthropic",
  "priority": 0,
  "autoFallbackEnabled": true,
  "rateLimitStatus": "OK",
  "rateLimitReset": "2024-12-17T11:00:00.000Z",
  "sessionInfo": "Session: 15 requests",
  "paused": false
}
```

### Log Messages

Auto-fallback events are logged with these patterns:

```
[INFO] Auto-fallback triggered to account primary-account (priority: 0, auto-fallback enabled)
[INFO] Continuing session for account secondary-account (15 requests in session)
```

## Advanced Configuration

### Custom Fallback Logic

For complex scenarios, you can combine auto-fallback with manual account management:

```bash
# Enable auto-fallback on selected accounts only
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

# Pause accounts during maintenance
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/pause

# Resume accounts after maintenance
curl -X POST http://localhost:8080/api/accounts/$ACCOUNT_ID/resume
```

### Integration with Monitoring

Set up monitoring for auto-fallback events:

```bash
# Script to monitor and alert on auto-fallback
#!/bin/bash
while true; do
  if tail -n 10 ~/.local/share/better-ccflare/logs/better-ccflare.log | grep -q "Auto-fallback"; then
    echo "⚠️ Auto-fallback triggered at $(date)"
    # Send notification (email, Slack, etc.)
  fi
  sleep 60
done
```

---

## Conclusion

The auto-fallback feature provides intelligent account management that automatically optimizes your Claude API usage according to your priorities. By carefully configuring account priorities and enabling auto-fallback on preferred accounts, you can achieve:

- **Cost Optimization** through automatic use of preferred accounts
- **Performance Maximization** by prioritizing higher-priority accounts
- **Reduced Manual Intervention** with automatic recovery from rate limits
- **Intelligent Load Balancing** that respects your business requirements

For questions or issues, refer to the [troubleshooting section](#troubleshooting) or check the main [documentation index](index.md).