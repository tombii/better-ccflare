# Claudeflare Configuration Guide

This guide covers all configuration options for Claudeflare, including file-based configuration, environment variables, and runtime API updates.

## Table of Contents

- [Configuration Overview](#configuration-overview)
- [Configuration Precedence](#configuration-precedence)
- [Configuration File Format](#configuration-file-format)
- [Configuration Options](#configuration-options)
- [Environment Variables](#environment-variables)
- [Runtime Configuration API](#runtime-configuration-api)
- [Example Configurations](#example-configurations)
- [Configuration Validation](#configuration-validation)
- [Migration Guide](#migration-guide)

## Configuration Overview

Claudeflare uses a flexible configuration system that supports:

- **File-based configuration**: JSON configuration file for persistent settings
- **Environment variables**: Override configuration for deployment flexibility
- **Runtime updates**: Modify certain settings via API without restart

Configuration is managed through the `@claudeflare/config` package, which provides automatic loading, validation, and change notifications.

## Configuration Precedence

Configuration values are resolved in the following order (highest to lowest priority):

1. **Environment variables** - Always take precedence when set
2. **Configuration file** - Values from `~/.claudeflare/config.json` (or custom path)
3. **Default values** - Built-in defaults when no other value is specified

### Special Cases

- **Load balancing strategy**: Environment variable `LB_STRATEGY` overrides file configuration
- **Runtime configuration**: Some values (like strategy) can be changed at runtime via API

## Configuration File Format

The configuration file is stored at:

- **Linux/macOS**: `~/.config/claudeflare/claudeflare.json` (or `$XDG_CONFIG_HOME/claudeflare/claudeflare.json`)
- **Windows**: `%LOCALAPPDATA%\claudeflare\claudeflare.json` (or `%APPDATA%\claudeflare\claudeflare.json`)
- **Custom path**: Set via `CLAUDEFLARE_CONFIG_PATH` environment variable

### File Structure

```json
{
  "lb_strategy": "session",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080,
  "stream_body_max_bytes": 262144
}
```

## Configuration Options

### Complete Options Table

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lb_strategy` | string | `"session"` | Load balancing strategy. Options: `"least-requests"`, `"round-robin"`, `"session"`, `"weighted"`, `"weighted-round-robin"` |
| `client_id` | string | `"9d1c250a-e61b-44d9-88ed-5944d1962f5e"` | OAuth client ID for authentication |
| `retry_attempts` | number | `3` | Maximum number of retry attempts for failed requests |
| `retry_delay_ms` | number | `1000` | Initial delay in milliseconds between retry attempts |
| `retry_backoff` | number | `2` | Exponential backoff multiplier for retry delays |
| `session_duration_ms` | number | `18000000` (5 hours) | Session persistence duration in milliseconds |
| `port` | number | `8080` | HTTP server port |
| `stream_body_max_bytes` | number | `262144` (256KB) | Maximum size for streaming response bodies in analytics capture |

### Load Balancing Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `least-requests` | Routes to the account with fewest active requests | Optimal for balanced load distribution |
| `round-robin` | Cycles through accounts sequentially | Simple, predictable distribution |
| `session` | Maintains client-account affinity for session duration | Best for stateful interactions |
| `weighted` | Routes based on account tier weights | Premium account prioritization |
| `weighted-round-robin` | Round-robin with tier-based weighting | Balanced with tier consideration |

### Logging Configuration (Environment Only)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `LOG_LEVEL` | string | `"INFO"` | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_FORMAT` | string | `"pretty"` | Log format: `"pretty"` or `"json"` |
| `CLAUDEFLARE_DEBUG` | string | - | Set to `"1"` to enable debug mode with console output |

## Environment Variables

### Configuration Mapping

| Environment Variable | Config Field | Type | Example |
|---------------------|--------------|------|---------|
| `LB_STRATEGY` | `lb_strategy` | string | `LB_STRATEGY=round-robin` |
| `CLIENT_ID` | `client_id` | string | `CLIENT_ID=your-client-id` |
| `RETRY_ATTEMPTS` | `retry_attempts` | number | `RETRY_ATTEMPTS=5` |
| `RETRY_DELAY_MS` | `retry_delay_ms` | number | `RETRY_DELAY_MS=2000` |
| `RETRY_BACKOFF` | `retry_backoff` | number | `RETRY_BACKOFF=1.5` |
| `SESSION_DURATION_MS` | `session_duration_ms` | number | `SESSION_DURATION_MS=3600000` |
| `PORT` | `port` | number | `PORT=3000` |
| `CF_STREAM_BODY_MAX_BYTES` | `stream_body_max_bytes` | number | `CF_STREAM_BODY_MAX_BYTES=524288` |
| `CLAUDEFLARE_CONFIG_PATH` | - | string | `CLAUDEFLARE_CONFIG_PATH=/etc/claudeflare.json` |

### Additional Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `LOG_LEVEL` | Set logging verbosity (DEBUG, INFO, WARN, ERROR) | `LOG_LEVEL=DEBUG` |
| `LOG_FORMAT` | Set log output format (pretty, json) | `LOG_FORMAT=json` |
| `CLAUDEFLARE_DEBUG` | Enable debug mode with console output | `CLAUDEFLARE_DEBUG=1` |
| `CLAUDEFLARE_DB_PATH` | Custom database file path | `CLAUDEFLARE_DB_PATH=/var/lib/claudeflare/db.sqlite` |
| `CF_PRICING_REFRESH_HOURS` | Hours between pricing data refreshes | `CF_PRICING_REFRESH_HOURS=12` |
| `CF_PRICING_OFFLINE` | Disable online pricing updates | `CF_PRICING_OFFLINE=1` |

## Runtime Configuration API

Some configuration values can be updated at runtime through the HTTP API without restarting the server.

### Available Endpoints

#### Get Current Configuration
```http
GET /api/config
```

Response:
```json
{
  "lb_strategy": "session",
  "port": 8080,
  "sessionDurationMs": 18000000
}
```

#### Get Current Strategy
```http
GET /api/config/strategy
```

Response:
```json
{
  "strategy": "session"
}
```

#### Update Strategy
```http
POST /api/config/strategy
Content-Type: application/json

{
  "strategy": "round-robin"
}
```

Response:
```json
{
  "success": true,
  "strategy": "round-robin"
}
```

#### Get Available Strategies
```http
GET /api/strategies
```

Response:
```json
["least-requests", "round-robin", "session", "weighted", "weighted-round-robin"]
```

### Runtime Update Behavior

- Strategy changes take effect immediately for new requests
- Existing sessions (for session strategy) are maintained until expiration
- Configuration file is automatically updated when changed via API
- Change events are emitted for monitoring and logging

## Example Configurations

### High Throughput Setup

Optimized for maximum request throughput with minimal overhead:

```json
{
  "lb_strategy": "least-requests",
  "retry_attempts": 2,
  "retry_delay_ms": 500,
  "retry_backoff": 1.5,
  "session_duration_ms": 300000,
  "port": 8080,
  "stream_body_max_bytes": 131072
}
```

Environment variables:
```bash
export LB_STRATEGY=least-requests
export RETRY_ATTEMPTS=2
export RETRY_DELAY_MS=500
export SESSION_DURATION_MS=300000  # 5 minutes
export CF_STREAM_BODY_MAX_BYTES=131072  # 128KB for faster streaming
export LOG_LEVEL=WARN  # Reduce logging overhead
```

### Session Persistence Setup

Ideal for maintaining conversation context with Claude:

```json
{
  "lb_strategy": "session",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 21600000,
  "port": 8080,
  "stream_body_max_bytes": 262144
}
```

Environment variables:
```bash
export LB_STRATEGY=session
export SESSION_DURATION_MS=21600000  # 6 hours
export RETRY_ATTEMPTS=3
export LOG_LEVEL=INFO
```

### Development Setup

Configuration for local development and debugging:

```json
{
  "lb_strategy": "round-robin",
  "retry_attempts": 5,
  "retry_delay_ms": 2000,
  "retry_backoff": 2,
  "session_duration_ms": 3600000,
  "port": 3000,
  "stream_body_max_bytes": 524288
}
```

Environment variables:
```bash
export PORT=3000
export LOG_LEVEL=DEBUG
export LOG_FORMAT=pretty
export CLAUDEFLARE_DEBUG=1
export RETRY_ATTEMPTS=5
```

### Premium Account Priority Setup

Leverage weighted strategies for tier-based routing:

```json
{
  "lb_strategy": "weighted-round-robin",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 7200000,
  "port": 8080,
  "stream_body_max_bytes": 262144
}
```

## Configuration Validation

### Automatic Validation

Claudeflare performs validation on:

1. **Strategy names**: Must be one of the valid strategy options (validated by `isValidStrategy`)
2. **Numeric values**: Parsed and validated as integers/floats
3. **Port ranges**: Should be valid port numbers (1-65535)
4. **File permissions**: Config directory is created with appropriate permissions
5. **Byte sizes**: Stream body max bytes must be a positive integer

### Validation Errors

Invalid configurations result in:

- **Strategy errors**: Throws error when setting via API, falls back to default strategy when loading
- **Parse errors**: Logged to console, uses default values
- **File errors**: Creates new config file with defaults
- **Invalid numeric values**: Falls back to default values

### Best Practices

1. **Test configuration changes**: Use the API to test strategy changes before updating files
2. **Monitor logs**: Check logs after configuration updates for validation errors
3. **Use environment variables**: For deployment-specific settings that shouldn't be committed
4. **Backup configurations**: Keep backups before major changes

## Migration Guide

### From Environment-Only Configuration

If migrating from environment variables to file-based configuration:

1. Create the configuration file:
   ```bash
   mkdir -p ~/.config/claudeflare
   ```

2. Export current configuration:
   ```bash
   curl http://localhost:8080/api/config > ~/.config/claudeflare/claudeflare.json
   ```

3. Edit and format the file:
   ```bash
   jq '.' ~/.config/claudeflare/claudeflare.json > temp.json && mv temp.json ~/.config/claudeflare/claudeflare.json
   ```

### From Older Versions

#### Pre-1.0 to Current

1. **Configuration location**: Move from `~/.claudeflare/config.json` to platform-specific paths
2. **Field naming**: Update any deprecated field names (none currently deprecated)
3. **Strategy names**: Ensure using kebab-case strategy names (e.g., `"round-robin"` not `"round_robin"`)

### Configuration Backup

Always backup your configuration before upgrades:

```bash
cp ~/.config/claudeflare/claudeflare.json ~/.config/claudeflare/claudeflare.json.backup
```

### Rollback Procedure

If issues occur after configuration changes:

1. **Via API**: Revert strategy changes using the runtime API
2. **File restoration**: Restore from backup configuration file
3. **Environment override**: Use environment variables to override problematic settings

## Troubleshooting

### Common Issues

1. **Configuration not loading**:
   - Check file permissions: `ls -la ~/.config/claudeflare/`
   - Verify JSON syntax: `jq '.' ~/.config/claudeflare/claudeflare.json`
   - Check logs for parse errors

2. **Environment variables not working**:
   - Ensure variables are exported: `export VAR=value`
   - Check variable names match exactly (case-sensitive)
   - Verify no typos in variable names

3. **Runtime updates not persisting**:
   - Check file write permissions
   - Ensure configuration directory exists
   - Look for save errors in logs

### Debug Mode

Enable comprehensive debugging:

```bash
export CLAUDEFLARE_DEBUG=1
export LOG_LEVEL=DEBUG
export LOG_FORMAT=json  # For structured logging
```

This provides detailed configuration loading information and operation logs.