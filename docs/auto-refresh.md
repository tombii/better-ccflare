# Auto-Refresh Configuration Guide

This guide covers the auto-refresh feature in better-ccflare, which automatically sends a small probe message to an account when its usage window resets, to start the new window. It applies to `anthropic`, `codex` and `zai` accounts.

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

- **Automatic Window Start**: Sends a probe message when a usage window resets to start a new window
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
5. **Probe Message**: One prompt is drawn from the probe pool and sent to start the new usage window
6. **Window Update**: The NEW `rate_limit_reset` from the API is stored (typically 5 hours in the future)
7. **Repeat**: Next refresh happens when that stored timestamp expires

### Algorithm Flow

```
Auto-Refresh Scheduler (runs every minute)
    ↓
Query: Find accounts where
  - auto_refresh_enabled = 1
  - not paused (or paused by failure_threshold / auto-pause overage)
  - provider IN ('anthropic', 'codex', 'zai')
  - not awaiting reauthentication
  - rate_limit_reset <= now (window has expired)
    ↓
For each candidate account (sequentially):
    ↓
Check: Has this account been refreshed before?
  → NO: Refresh it (first time)
  → YES: Check if stored rate_limit_reset <= now
      → YES: Window has expired, refresh it
      → NO: Window still active, skip it
    ↓
Claim a prompt from the 500-prompt pool (locked for 24h)
  → pool dry: send nothing, log when the first prompt frees up, stop here
    ↓
Send it through the proxy as a Claude Code CLI request (max_tokens: 10)
    ↓
Get NEW rate_limit_reset from API response (e.g., now + 5 hours)
    ↓
Update database: rate_limit_reset = new value
    ↓
Update tracking map: lastRefreshResetTime[account_id] = new value
    ↓
Next check: Will refresh again when new value expires (5 hours later)
```

### Probe Prompts

Every refresh draws one prompt from a shared pool of 500 short questions
(`packages/proxy/src/auto-refresh-prompt-pool.ts`) and sends it with
`max_tokens: 10`, so the reply is capped and thrown away — the prompt itself is
the only real cost. The five prompts this feature originally rotated through
("What is 2+2?", "Tell me a programmer joke", …) are still in the pool, verbatim.

The pool has six rules, and each one is load-bearing:

- **500 distinct prompts, deliberately uneven in shape.** Arithmetic, geography,
  shell and git one-liners, conversions, acronyms, one-word-back questions. 500
  variants of "What is X?" would be as recognisable as one repeated string.
- **A drawn prompt is locked for 24 hours** (`PROMPT_COOLDOWN_MS`). A prompt sent
  now cannot be sent again — by this account or any other — until tomorrow.
- **A claim is exclusive.** `claimAutoRefreshPrompt()` chooses a free index and
  stamps it before it returns, with no `await` in between. Two accounts
  refreshing in the same tick therefore cannot be handed the same text: the
  first one wins it and the second is given the next free prompt. "First one
  wins" is structural here, not luck.
- **A claim that was never sent is given back.** The claim happens before the
  scheduler knows whether it can send at all, so the paths that prove nothing
  left the process — no provider registered for the account, a throw before the
  request was issued — call `releaseAutoRefreshPrompt()` and the prompt returns
  to circulation immediately. The lock is there to stop the same text being
  *sent* twice in a day; a claim that never became a request is not a lock, it
  is a leak. The mirror of that rule: once a request has gone out the prompt
  stays locked whatever came back, including an error, because the text was
  sent.
- **A failure that is not counted still costs a wait, and the wait escalates.**
  Two outcomes never reach the consecutive-failure counter on purpose: a 529
  (overloaded or throttled — see the exemption below) and a request that
  produced no response at all. Neither pauses the account, so on their own they
  leave it eligible again on the very next 60s tick. Each of those re-probes
  spends a prompt that cannot be handed back, so an account stuck in that state
  would drain all 500 in a little over eight hours and stop every other account
  from refreshing.

  So consecutive uncounted failures climb a ladder —
  `UNCOUNTED_FAILURE_BACKOFF_MS`, which is **1m, 5m, 10m, 30m, 1h, 6h, 12h** —
  and stay on the last rung. A ladder rather than one flat wait because the two
  ends want opposite things: a single blip should cost a minute, since the
  account is probably fine and the next window rollover should be caught
  quickly, while an account that has been failing all day should be asked twice
  a day. The first successful probe drops it straight back to the bottom rung,
  so a later blip costs a minute again instead of resuming the climb. The
  failures that *are* counted keep going through the five-strike pause
  threshold untouched, and the separate `FAILURE_PROBE_COOLDOWN_MS` that
  throttles re-probes of already-paused accounts is untouched too.

  **From the 1-hour rung up, the account also loses its place in the queue.**
  The short rungs say nothing worth acting on, but an account the provider has
  been refusing for an hour or more is telling us something about live traffic
  as well, not just about probes. So the scheduler registers it in
  `PROBE_BACKOFF_PENALTY_THRESHOLD_MS` terms (`packages/core/src/probe-backoff.ts`)
  and every load-balancer strategy sorts it behind accounts with no such
  history — `compareAccountPreference` replaces the bare priority comparison,
  and `preemptsOnPreference` stops a penalised account from stealing an active
  session from a healthy one. Within each group the configured priority still
  decides.

  It stays a penalty and never becomes a ban: a penalised account is still
  selected when it is the best remaining option, because the alternative is an
  install where everything is having a bad hour and there is nothing left to
  route to. The penalty expires with the rung that earned it, and the first
  successful probe clears it outright — an account is not made to serve out
  hours of a penalty it has already disproved. The registry is in memory only,
  like the prompt pool: what it holds is "how have the last few hours gone",
  which a restart is entitled to forget.

  Rationing the rate is what bounds the total, because a claim is released
  after `PROMPT_COOLDOWN_MS` rather than kept forever: what has to fit in the
  pool is not every probe ever sent but the ones alive inside one 24-hour lock
  window, which is rate x window. A chronically failing account settles at two
  probes a day, so it holds two prompts — and even its worst stretch, the climb
  from the bottom rung, is seven probes across the first twenty hours. The
  honest residual is therefore an order of magnitude away: it would take
  something like sixty accounts all entering that state at once to reach a dry
  pool, which is the condition the dry-pool alarm below exists to announce.
- **A dry pool sends nothing.** If every prompt is inside its cooldown, the
  claim fails and `sendDummyMessage` returns `false` without sending, without
  touching the account row, and **without counting a failure** — holding off is
  not the account misbehaving, so it must not feed the consecutive-failure
  pause. The log names the moment the earliest-locked prompt frees up, once per
  episode rather than once per minute.

Draining the pool takes 500 refreshes inside 24 hours, and a healthy install
does a couple of dozen. So the dry-pool branch is an alarm, not a routine state:
it is the last line of defence if something ever puts the scheduler into a
per-minute refresh loop. The uncounted-failure ladder above is the first one —
it takes a single misbehaving account from sixty probes an hour down to two a
day, so reaching a dry pool means something is looping that neither guard
anticipated.

`autoRefreshPromptPoolStatus()` reports `{ free, total, retryAt }` for
inspection.

**Cooldown state is in memory only.** What it protects is "did we send this in
the last day"; a restart losing it costs a 1-in-500 chance of an early repeat,
which does not justify a schema migration (and its PostgreSQL port).

### Why the Prompts Are Varied (Do Not "Optimise" This)

The refresh probe is automated traffic dressed as a real Claude Code CLI
request, and that disguise is intentional in three places:

1. **The prompt is a question a person might plausibly have typed** — and it
   changes every time.
2. **The request wears the CLI's identity**: `user-agent:
   claude-cli/<version> (external, cli)`, the whole `x-stainless-*` header set,
   `anthropic-beta`, `anthropic-version`.
3. **It goes through the proxy** (`localhost:<port>/v1/messages` with
   `x-better-ccflare-account-id`), not straight at the provider, so it travels
   the same path as real traffic.

Real accounts can be banned for automated/scripted usage. A fixed cheap string
on a timer — a single `"."`, or the same question every hour — is a perfect
robot fingerprint, which is why the cost of the varied prompt is accepted
instead of being optimised away.

**Rejected, and recorded so it is not re-proposed:** making the scheduler send
the manual refresh button's minimal `"."` ping for Codex accounts. It was
implemented and reverted. It saves a handful of input tokens per refresh and
pays for them with the only camouflage the probe has. The button is a different
case and keeps its `"."`: it fires only when a human clicks it, so it has no
cadence to fingerprint.

## Setting Up Auto-Refresh

### Prerequisites

1. **Supported Provider**: The scheduler only considers `anthropic`, `codex` and `zai` accounts. The probe is always an Anthropic-shaped request sent through the proxy, which routes it to the forced account and translates the model name for the other two.
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

#### 3. "All probe prompts are inside their 24h cooldown"

**Symptoms:**
- A warning naming the time the first prompt frees up, and nothing being sent

**What it means:**
This takes 500 refreshes inside one day, so it is almost never the pool's fault
— it means something is asking for refreshes in a loop. The usual cause is a
`rate_limit_reset` stuck in the past (the scheduler then sees "window reset"
every minute), so check the account's stored reset first:

```bash
sqlite3 ~/.config/better-ccflare/better-ccflare.db \
  "SELECT name, provider, datetime(rate_limit_reset/1000,'unixepoch') FROM accounts WHERE auto_refresh_enabled = 1;"
```

Nothing is sent while the pool is dry, and the accounts are not penalised for
it — the refusal is not counted as a refresh failure.

#### 4. Too Frequent Refreshes

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
[INFO] Sending auto-refresh message to account: my-account (prompt #137)
[INFO] Auto-refresh message sent successfully for account: my-account
[INFO] Updated rate_limit_reset for my-account to 2024-12-17T11:00:00.000Z
[ERROR] Auto-refresh message failed for account my-account: 429 Too Many Requests
[WARN]  Auto-refresh is sending nothing for my-account: all 500 probe prompts are inside their 24h cooldown, ... The first prompt frees up at 2024-12-18T09:12:00.000Z.
[DEBUG] Auto-refresh still holding off on my-account until 2024-12-18T09:12:00.000Z — every probe prompt is on cooldown
```

The `prompt #N` index is the pool position, not the prompt text: the log stays
readable and the probe's content stays out of it.

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
