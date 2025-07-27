# Claudeflare TUI Documentation

## Overview

The Claudeflare Terminal User Interface (TUI) provides an interactive way to manage your Claude API load balancer. It offers real-time monitoring, account management, and comprehensive analytics all from your terminal.

### Key Features

- **Interactive Navigation**: Menu-driven interface with keyboard shortcuts
- **Real-time Updates**: Live monitoring of requests, logs, and statistics
- **Account Management**: Add, remove, and monitor OAuth accounts
- **Request History**: View detailed request/response information
- **Statistics Dashboard**: Track usage, costs, and performance metrics
- **Log Streaming**: Real-time log viewer with filtering capabilities
- **Auto-start Server**: The API server starts automatically when you launch the TUI

## Installation and Launching

### Prerequisites

- Bun runtime (v1.2.8 or higher)
- Claudeflare project dependencies installed

### Launching the TUI

There are two ways to launch the TUI:

```bash
# Using the dev script
bun run dev

# Direct execution
bun run apps/tui/src/main.ts
```

The TUI will automatically start the API server on port 8080 (or your configured port) when launched.

### Command Line Options

The TUI also supports non-interactive command line operations:

```bash
# Show help
bun run dev --help

# Start server only (no TUI)
bun run dev --serve

# View logs
bun run dev --logs [N]  # Stream latest N lines then follow

# View statistics (JSON output)
bun run dev --stats

# Account management
bun run dev --add-account <name> [--mode max|console] [--tier 1|5|20]
bun run dev --list
bun run dev --remove <name>

# Maintenance
bun run dev --reset-stats
bun run dev --clear-history
```

## Navigation and Keyboard Shortcuts

### Global Navigation

- **Arrow Keys (↑/↓)**: Navigate through menu items
- **Enter**: Select the highlighted option
- **ESC**: Go back to the previous screen
- **q**: Quit the current screen (same as ESC in most screens)

### Screen-Specific Shortcuts

#### Home Screen
- Use arrow keys to navigate the main menu
- Press Enter to select an option
- Select "Exit" or press Ctrl+C to quit the TUI

#### Server Status Screen
- **d**: Open the dashboard in your default web browser
- **q/ESC**: Return to home screen

#### Accounts Management Screen
- **Enter**: Select an account to manage/remove
- **ESC**: Cancel current operation or go back

#### Request History Screen
- **↑/↓**: Navigate through requests
- **Enter/Space**: View detailed information for selected request
- **r**: Refresh the request list
- **q/ESC**: Go back (or exit details view if open)

#### Statistics Dashboard Screen
- **r**: Manually refresh statistics
- **q/ESC**: Return to home screen
- Auto-refreshes every 5 seconds

#### Logs Viewer Screen
- **Space**: Pause/resume log streaming
- **c**: Clear the current log display
- **q/ESC**: Return to home screen

## Screen Descriptions

### 1. Home Screen

The main menu presents all available options:

```
🎯 Claudeflare TUI

Select an option:
  🚀 Server
  👥 Manage Accounts
  📊 View Statistics
  📜 View Requests
  📋 View Logs
  ❌ Exit
```

*[Screenshot placeholder: Home screen with menu options]*

### 2. Server Status Screen

Shows the current server status and provides quick access to the web dashboard:

```
🚀 Server

✓ Server running at http://localhost:8080

Press 'd' to open dashboard in browser

Press 'q' or ESC to go back
```

*[Screenshot placeholder: Server status screen]*

### 3. Accounts Management Screen

Manage your OAuth accounts with an interactive interface:

```
👥 Manage Accounts

2 account(s) configured

  work-account (tier 5)
  personal (tier 1)
  ➕ Add Account
  ← Back
```

#### Adding an Account

The add account flow guides you through:
1. **Account Name**: Enter a unique identifier
2. **Mode Selection**: Choose between "max" (recommended) or "console"
3. **Tier Selection**: Select tier 1, 5, or 20
4. **OAuth Authentication**: Browser opens automatically
5. **Code Entry**: Enter the authorization code after authentication

*[Screenshot placeholder: Add account flow]*

#### Removing an Account

Safety confirmation required - type the account name to confirm deletion:

```
⚠️ Confirm Account Removal

You are about to remove account 'work-account'.
This action cannot be undone.

Type work-account to confirm:
```

*[Screenshot placeholder: Remove account confirmation]*

### 4. Request History Screen

View recent API requests with detailed information:

```
📜 Request History
Use ↑/↓ to navigate, ENTER to view details

▶ 10:23:45 - 200 - work-acc... 
  10:23:44 - 429 - personal... [RATE LIMITED]
  10:23:43 - 200 - work-acc...
  10:23:42 - 500 - personal... - Connection timeout...

Press 'r' to refresh • 'q' or ESC to go back
```

Detail view shows:
- Request/response headers
- Body content (decoded from base64)
- Status codes with color coding
- Timing and retry information
- Rate limit indicators

*[Screenshot placeholder: Request history and detail view]*

### 5. Statistics Dashboard Screen

Real-time statistics with automatic updates:

```
📊 Statistics

Overall Stats
  Total Requests: 1,245
  Success Rate: 98.5%
  Active Accounts: 2
  Avg Response Time: 234ms
  Total Tokens: 1,234,567
    ├─ Input: 234,567
    ├─ Cache Read: 12,345
    ├─ Cache Creation: 1,234
    └─ Output: 123,456
  Total Cost: $12.45

Account Usage
  work-account: 845 requests (99% success)
  personal: 400 requests (97% success)

Press 'r' to refresh • 'q' or ESC to go back
```

*[Screenshot placeholder: Statistics dashboard]*

### 6. Logs Viewer Screen

Stream logs with pause and clear capabilities:

```
📜 Logs

[INFO] Request received from 127.0.0.1
[INFO] Using account: work-account
[WARN] Rate limit approaching for personal
[ERROR] Failed to refresh token for expired-account
[INFO] Request completed in 234ms

SPACE: Pause • 'c': Clear • 'q'/ESC: Back
```

Features:
- Shows last 200 log entries
- Loads historical logs on startup
- Real-time streaming when not paused
- Color-coded log levels

*[Screenshot placeholder: Logs viewer with various log levels]*

## Interactive Features

### Account OAuth Flow

1. Select "Add Account" from the Accounts screen
2. Enter a unique account name
3. Choose the mode:
   - **max**: Full Claude API access (recommended)
   - **console**: Limited console access
4. Select the tier based on your subscription
5. Browser opens automatically for OAuth authentication
6. Complete the authorization in your browser
7. Return to the TUI and enter the authorization code
8. Account is added and ready to use

### Real-time Updates

- **Statistics**: Updates every 5 seconds
- **Logs**: Streams in real-time (pauseable)
- **Requests**: Manual refresh with 'r' key
- **Account Status**: Updates on screen refresh

## Color Coding and Indicators

### Status Colors

- **Green**: Success, healthy, running
- **Yellow**: Warning, client errors (4xx)
- **Red**: Error, server errors (5xx), failures
- **Orange**: Rate limited
- **Cyan**: Selected items, headers
- **Gray/Dim**: Supplementary information

### Status Indicators

- **✓**: Success or active
- **⚠️**: Warning or confirmation required
- **▶**: Currently selected item
- **├─ └─**: Tree structure for nested data
- **[RATE LIMITED]**: Account hit rate limits
- **[PAUSED]**: Log streaming is paused

## Tips and Tricks

### Performance Optimization

1. **Pause logs** when not actively monitoring to reduce CPU usage
2. **Clear logs** periodically if the buffer gets too large
3. Use **focused screens** instead of keeping all screens open

### Account Management Best Practices

1. **Name accounts meaningfully**: Use descriptive names like "work-production" or "personal-dev"
2. **Monitor rate limits**: Check the Statistics screen regularly
3. **Distribute load**: Add multiple accounts to improve throughput
4. **Remove expired accounts**: Clean up accounts that fail authentication

### Troubleshooting

1. **TUI not responding**: Press ESC multiple times to return to home
2. **Server not starting**: Check if port 8080 is already in use
3. **OAuth issues**: Ensure your browser allows pop-ups for OAuth flow
4. **Performance issues**: Reduce terminal size or pause log streaming

### Advanced Usage

1. **Multiple instances**: Run different instances on different ports
2. **Headless operation**: Use command-line flags for automation
3. **JSON output**: Use `--stats` flag for programmable statistics
4. **Log filtering**: Pipe `--logs` output through grep for filtering

## Integration with CI/CD

The TUI's command-line interface makes it suitable for automation:

```bash
# Add account in CI
bun run dev --add-account ci-account --mode max --tier 5

# Check statistics in scripts
STATS=$(bun run dev --stats)
REQUESTS=$(echo $STATS | jq '.totalRequests')

# Monitor logs in background
bun run dev --logs | grep ERROR > error.log &
```

## Known Limitations

1. **Terminal Size**: Requires minimum 80x24 terminal size
2. **Color Support**: Best experience with 256-color terminals
3. **Windows Support**: May have rendering issues on Windows terminals
4. **Concurrent Access**: TUI is designed for single-user access

## Troubleshooting Common Issues

### TUI Won't Start

```bash
# Check if another instance is running
lsof -i :8080

# Kill existing process if needed
kill -9 <PID>

# Try with a different port
bun run dev --serve --port 8081
```

### Account Authentication Fails

1. Check browser allows pop-ups
2. Ensure you're logged into Claude
3. Verify the account has proper permissions
4. Try removing and re-adding the account

### Performance Issues

1. Reduce terminal window size
2. Pause log streaming when not needed
3. Clear request history periodically
4. Close unused screens

## Support

For issues or feature requests related to the TUI, please check:
- Project documentation
- GitHub issues
- Error messages in the logs screen