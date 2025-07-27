# Claudeflare Documentation

## Intelligent Load Balancing for Claude API

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Bun](https://img.shields.io/badge/bun-%3E%3D1.2.8-f472b6)

## Overview

Claudeflare is a sophisticated load balancer proxy designed to maximize your Claude API usage by intelligently distributing requests across multiple OAuth accounts. Built with performance and reliability in mind, it provides automatic failover, session-based routing for optimal prompt caching, and comprehensive monitoring capabilities.

### Why Claudeflare?

When working with Claude API at scale, rate limits can become a significant bottleneck. Claudeflare solves this by:

- **Maximizing Prompt Cache Efficiency**: Default session-based routing keeps conversations on the same account for 5 hours, dramatically improving cache hit rates and reducing costs
- **Seamless Failover**: Automatically switches to the next available account when rate limits are hit, ensuring uninterrupted service
- **Tier-Aware Distribution**: Supports Pro (1x), Max 5x, and Max 20x accounts with intelligent capacity-based routing
- **Real-time Monitoring**: Web dashboard provides instant visibility into usage, performance, and account health
- **Zero Configuration Changes**: Acts as a transparent proxy - just point your Claude client to Claudeflare

## Key Features

- 🔄 **Multiple Load Balancing Strategies**: Session-based (default), round-robin, weighted, and least-requests algorithms
- 📊 **Account Tier Support**: Intelligently manages accounts with different capacity multipliers (1x, 5x, 20x)
- 🚀 **Automatic Failover**: Seamless switching between accounts when rate limits are encountered
- 🔁 **Smart Retry Logic**: Configurable retry attempts with exponential backoff per account
- 📈 **Comprehensive Analytics**: Track requests, response times, token usage, and costs
- 🌐 **Web Dashboard**: Real-time monitoring interface with strategy switching and account management
- 🔧 **CLI Management**: Command-line tools for account configuration and maintenance
- 🗄️ **Request History**: SQLite-based storage for complete request tracking and analysis
- 🔐 **OAuth Token Management**: Automatic token refresh and secure credential storage
- 🏗️ **Extensible Architecture**: Provider-based design ready for additional AI services

## Documentation

### Getting Started
- [Quick Start Guide](./quick-start.md) - Get up and running in 5 minutes
- [Installation](./installation.md) - Detailed installation instructions
- [Configuration](./configuration.md) - Configuration options and environment variables

### Architecture & Design
- [System Architecture](./architecture.md) - Overview of system components and design principles
- [Data Flow](./data-flow.md) - Request lifecycle and data flow through the system
- [Load Balancing Strategies](./load-balancing.md) - Deep dive into available load balancing algorithms
- [Database Schema](./database.md) - SQLite database structure and migrations

### Core Components
- [Provider Registry](./providers.md) - Provider abstraction and OAuth implementation
- [HTTP API Reference](./api-http.md) - Complete REST API documentation
- [CLI Commands](./cli.md) - Command-line interface reference
- [Terminal UI Guide](./tui.md) - Interactive terminal interface documentation

### Operations & Deployment
- [Deployment Guide](./deployment.md) - Production deployment best practices
- [Security Considerations](./security.md) - Security guidelines and recommendations
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [Performance Tuning](./performance.md) - Optimization tips and benchmarks

### Development
- [Contributing Guidelines](./contributing.md) - How to contribute to Claudeflare
- [Development Setup](./development.md) - Setting up a development environment
- [API Development](./api-development.md) - Extending the API and adding features
- [Testing Guide](./testing.md) - Testing strategies and running tests

## Quick Start

### 1. Install Claudeflare

```bash
# Clone the repository
git clone https://github.com/yourusername/claudeflare.git
cd claudeflare

# Install dependencies
bun install
```

### 2. Add Your Claude Accounts

```bash
# Add a Pro account (1x capacity)
bun cli add my-pro-account --mode max --tier 1

# Add a Max 5x account
bun cli add my-max-account --mode max --tier 5

# Add an API Console account
bun cli add my-api-account --mode console
```

### 3. Start the Server

```bash
# Start with default session-based strategy
bun start

# Or specify a different strategy
LB_STRATEGY=weighted bun start
```

### 4. Configure Your Claude Client

```bash
# Set the base URL to use Claudeflare
export ANTHROPIC_BASE_URL=http://localhost:8080
```

### 5. Monitor via Dashboard

Open your browser to [http://localhost:8080/dashboard](http://localhost:8080/dashboard) to view real-time statistics and manage accounts.

## Related Resources

### External Links
- [Claude API Documentation](https://docs.anthropic.com/claude/docs) - Official Anthropic API docs
- [Bun Documentation](https://bun.sh/docs) - Bun runtime documentation
- [SQLite Documentation](https://www.sqlite.org/docs.html) - SQLite database docs

### Community & Support
- [GitHub Issues](https://github.com/yourusername/claudeflare/issues) - Report bugs and request features
- [Discussions](https://github.com/yourusername/claudeflare/discussions) - Community discussions
- [Discord Server](https://discord.gg/claudeflare) - Real-time chat and support

### Related Projects
- [Claude SDK](https://github.com/anthropics/anthropic-sdk-typescript) - Official TypeScript SDK
- [LangChain](https://github.com/langchain-ai/langchain) - Framework for LLM applications
- [LiteLLM](https://github.com/BerriAI/litellm) - Unified interface for LLM APIs

## License

Claudeflare is open source software licensed under the MIT License. See the [LICENSE](../LICENSE) file for details.

---

<div align="center">
  <p>Built with ❤️ using <a href="https://bun.sh">Bun</a></p>
  <p>
    <a href="./quick-start.md">Get Started</a> •
    <a href="./architecture.md">Learn More</a> •
    <a href="./contributing.md">Contribute</a>
  </p>
</div>