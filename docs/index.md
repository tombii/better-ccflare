# better-ccflare Documentation

## Track Every Request. Go Low-Level. Never Hit Rate Limits Again.

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Bun](https://img.shields.io/badge/bun-%3E%3D1.2.8-f472b6)

## Overview

better-ccflare is the ultimate Claude API proxy with intelligent load balancing across multiple accounts. Built with TypeScript and Bun runtime, it provides full visibility into every request, response, and rate limit, ensuring your AI applications never experience downtime due to rate limiting.

### Why better-ccflare?

When working with Claude API at scale, rate limits can become a significant bottleneck. better-ccflare solves this by:

- **🚀 Zero Rate Limit Errors**: Automatically distributes requests across multiple accounts with intelligent failover
- **📊 Request-Level Analytics**: Track latency, token usage, and costs in real-time with <10ms overhead
- **🔍 Deep Debugging**: Full request/response logging and error traces for complete visibility
- **💸 Session-Based Routing**: Default 5-hour sessions maximize prompt cache efficiency, reducing costs
- **⚡ Production Ready**: Built for scale with SQLite persistence, OAuth token refresh, and configurable retry logic

## Key Features

### 🎯 Intelligent Load Balancing
- **Session-based** (only supported strategy): Maintains conversation context with 5-hour sessions to avoid rate limits and account bans
- **⚠️ WARNING**: Other strategies (round-robin, least-requests, weighted) have been removed as they can trigger Claude's anti-abuse systems

### 📈 Real-Time Monitoring & Analytics
- **Web Dashboard**: Interactive UI at `/dashboard` with live metrics
- **Powerful CLI**: Comprehensive command-line interface for management and monitoring
- **Request Tracking**: Complete history with token usage and costs
- **Performance Metrics**: Response times, success rates, and error tracking

### 🛠️ Developer Experience
- **Zero Config Proxy**: Drop-in replacement for Claude API
- **CLI Management**: Add, remove, and manage accounts easily
- **Automatic Failover**: Seamless switching on rate limits
- **OAuth Token Refresh**: Handles authentication automatically

### 🏗️ Production Ready
- **SQLite Persistence**: Reliable data storage with migrations
- **Configurable Retry Logic**: Smart exponential backoff
- **Account Priority System**: Support for priority-based load balancing
- **Extensible Architecture**: Provider-based design for future AI services

## Documentation

### Getting Started
- [Configuration Guide](./configuration.md) - Environment variables and configuration options
- [Architecture Overview](./architecture.md) - System components and design principles
- [Data Flow](./data-flow.md) - Request lifecycle through the system

### Core Features
- [Load Balancing Strategy](./load-balancing.md) - Session-based strategy for safe account usage
- [Provider System](./providers.md) - Provider abstraction and OAuth implementation
- [Database Schema](./database.md) - SQLite structure, migrations, and maintenance
- [Model Mappings](./models.md) - Claude AI model definitions and constants

### User Interfaces
- [HTTP API Reference](./api-http.md) - Complete REST API documentation
- [CLI Commands](./cli.md) - Comprehensive command-line interface reference

### Operations
- [Migration Guide: v2 to v3](./migration-v2-to-v3.md) - Upgrading from version 2.x to 3.x
- [Deployment Guide](./deployment.md) - Production deployment with Docker, systemd, PM2, and Kubernetes
- [Security Considerations](./security.md) - Authentication, encryption, and best practices
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [Contributing](./contributing.md) - Development setup and contribution guidelines

### API Reference
- [Anthropic API Changelog](./anthropic-api-changelog.md) - Track changes to Anthropic's usage API responses

## Quick Start

### 1. Install better-ccflare

```bash
# Clone the repository
git clone https://github.com/snipeship/better-ccflare.git
cd better-ccflare

# Install dependencies
bun install
```

### 2. Start better-ccflare (CLI + Server)

```bash
# Start better-ccflare with CLI (automatically starts server if no command specified)
bun run cli

# Or start just the server
bun run server

# Start server on specific port
bun run server --port 8081

# Specify session duration (default: 5 hours)
SESSION_DURATION_MS=21600000 bun run server  # 6 hours

# Run CLI directly with Bun (if not using npm scripts)
bun run apps/cli/src/main.ts
```

### 3. Add Your Claude Accounts

```bash
# In another terminal, add your accounts
# Add a work account
bun run apps/cli/src/main.ts --add-account work-account --mode max --priority 0

# Add a personal account
bun run apps/cli/src/main.ts --add-account personal-account --mode max --priority 10

# Add accounts with specific priorities
bun run apps/cli/src/main.ts --add-account pro-account --mode max --priority 0
bun run apps/cli/src/main.ts --add-account max-account --mode max --priority 10

# Or if you have better-ccflare command available globally
better-ccflare --add-account work-account --mode max --priority 0
```

### 4. Configure Your Claude Client

```bash
# Set the base URL to use better-ccflare
export ANTHROPIC_BASE_URL=http://localhost:8080
```

### 5. Monitor Your Usage

- **Web Dashboard**: Open [http://localhost:8080/dashboard](http://localhost:8080/dashboard) for real-time analytics
- **CLI**: Check status with `bun run apps/cli/src/main.ts --list`
- **Stats**: View detailed statistics with `bun run apps/cli/src/main.ts --stats`

## Project Structure

```
better-ccflare/
├── apps/               # Application packages
│   ├── server/        # Main proxy server
│   ├── cli/           # CLI application
│   └── lander/        # Landing page
├── packages/          # Core packages
│   ├── core/          # Core business logic
│   ├── cli-commands/  # CLI command implementations
│   ├── database/      # SQLite database layer
│   ├── dashboard-web/ # Web dashboard UI
│   ├── http-api/      # REST API handlers
│   ├── load-balancer/ # Load balancing strategies
│   ├── logger/        # Logging utilities
│   ├── providers/     # OAuth provider system
│   └── proxy/         # HTTP proxy implementation
└── docs/              # Documentation

```

## Scripts Reference

```bash
# Main commands
bun run cli            # Start CLI (builds dashboard first)
bun run server         # Start server only
bun run start          # Alias for bun run server

# Development
bun run dev            # Start CLI in development mode
bun run dev:server     # Server with hot reload
bun run dev:dashboard  # Dashboard development

# Build & Quality
bun run build          # Build dashboard and CLI
bun run build:dashboard # Build web dashboard
bun run build:cli      # Build CLI
bun run build:lander   # Build landing page
bun run typecheck      # Check TypeScript types
bun run lint           # Fix linting issues
bun run format         # Format code
```

## CLI Commands

The better-ccflare CLI provides comprehensive command-line interface for management and monitoring:

```bash
# If running without global install, use the full path:
bun run apps/cli/src/main.ts [command]

# Account management
bun run apps/cli/src/main.ts --add-account <name> --mode <max|console|zai|openai-compatible> --priority <number>  # Add account
bun run apps/cli/src/main.ts --list                   # List accounts
bun run apps/cli/src/main.ts --remove <name>          # Remove account
bun run apps/cli/src/main.ts --pause <name>           # Pause account
bun run apps/cli/src/main.ts --resume <name>          # Resume account
bun run apps/cli/src/main.ts --set-priority <name> <priority>  # Set account priority

# Server management
bun run apps/cli/src/main.ts --serve                  # Start server
bun run apps/cli/src/main.ts --serve --port 8081    # Start on specific port
bun run apps/cli/src/main.ts --logs [N]               # Stream logs
bun run apps/cli/src/main.ts --stats                  # Show statistics (JSON)

# Maintenance
bun run apps/cli/src/main.ts --reset-stats            # Reset statistics
bun run apps/cli/src/main.ts --clear-history          # Clear request history
bun run apps/cli/src/main.ts --analyze                # Analyze database performance

# Configuration
bun run apps/cli/src/main.ts --get-model               # Show current model
bun run apps/cli/src/main.ts --set-model <model>       # Set default model
bun run apps/cli/src/main.ts --help                   # Show help
```

For more detailed CLI documentation, see [CLI Commands](./cli.md).

## Environment Variables

```bash
# Server Configuration
PORT=8080                        # Server port (default: 8080)
LB_STRATEGY=session             # Load balancing strategy (only 'session' supported)
SESSION_DURATION_MS=18000000    # Session duration in ms (default: 5 hours)

# OAuth Configuration
CLIENT_ID=<your-client-id>      # Custom OAuth client ID (optional)

# Retry Configuration
RETRY_ATTEMPTS=3                # Number of retry attempts (default: 3)
RETRY_DELAY_MS=1000            # Initial retry delay in ms (default: 1000)
RETRY_BACKOFF=2                # Exponential backoff multiplier (default: 2)

# Development
LOG_LEVEL=info                  # Logging level (debug|info|warn|error)
NODE_ENV=production            # Environment mode
```

## Related Resources

### External Links
- [Claude API Documentation](https://docs.anthropic.com/claude/docs) - Official Anthropic API docs
- [Bun Documentation](https://bun.sh/docs) - Bun runtime documentation
- [SQLite Documentation](https://www.sqlite.org/docs.html) - SQLite database docs

### Support
- [GitHub Repository](https://github.com/snipeship/better-ccflare) - Source code and issues
- [Contributing](./contributing.md) - How to contribute to better-ccflare

## License

better-ccflare is open source software licensed under the MIT License. See the [LICENSE](../LICENSE) file for details.

---

<div align="center">
  <p>Built with ❤️ for developers who ship</p>
  <p>
    <a href="#quick-start">Get Started</a> •
    <a href="./architecture.md">Learn More</a> •
    <a href="./contributing.md">Contribute</a>
  </p>
</div>