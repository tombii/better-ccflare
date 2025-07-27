# Claudeflare 🛡️

**Track Every Request. Go Low-Level. Never Hit Rate Limits Again.**

The ultimate Claude API proxy with intelligent load balancing across multiple accounts. Full visibility into every request, response, and rate limit.

![Claudeflare Dashboard](apps/lander/src/screenshot-dashboard.png)

## Why Claudeflare?

- **🚀 Zero Rate Limit Errors** - Automatically distribute requests across multiple accounts
- **📊 Request-Level Analytics** - Track latency, token usage, and costs in real-time  
- **🔍 Deep Debugging** - Full request/response logging and error traces
- **⚡ <10ms Overhead** - Minimal performance impact on your API calls
- **💸 Free & Open Source** - Run it yourself, modify it, own your infrastructure

## Quick Start

```bash
# Clone and install
git clone https://github.com/snipeship/claudeflare
cd claudeflare
bun install

# Start Claudeflare (TUI + Server)
bun run claudeflare

# In another terminal, add your Claude accounts
bun cli add work-account
bun cli add personal-account

# Configure Claude SDK
export ANTHROPIC_BASE_URL=http://localhost:8080
```

## Features

### 🎯 Intelligent Load Balancing
- **Round-robin** - Even distribution across accounts
- **Least-requests** - Route to account with fewest requests
- **Session-based** - Maintain conversation context (5hr sessions)
- **Weighted** - Prioritize accounts by tier (Free/Pro/Team)

### 📈 Real-Time Analytics
- Token usage tracking per request
- Response time monitoring
- Rate limit detection and warnings
- Cost estimation and budgeting

### 🛠️ Developer Tools
- Interactive TUI (`bun run dev`)
- Web dashboard (`http://localhost:8080/dashboard`)
- CLI for account management
- REST API for automation

### 🔒 Production Ready
- Automatic failover between accounts
- OAuth token refresh handling
- SQLite database for persistence
- Configurable retry logic

## Documentation

Full documentation available in [`docs/`](docs/):
- [Getting Started](docs/index.md)
- [Architecture](docs/architecture.md) 
- [API Reference](docs/api-http.md)
- [Configuration](docs/configuration.md)
- [Load Balancing Strategies](docs/load-balancing.md)

## Screenshots

<table>
  <tr>
    <td><img src="apps/lander/src/screenshot-dashboard.png" alt="Dashboard"/></td>
    <td><img src="apps/lander/src/screenshot-logs.png" alt="Logs"/></td>
  </tr>
  <tr>
    <td align="center"><b>Real-time Dashboard</b></td>
    <td align="center"><b>Request Logs</b></td>
  </tr>
  <tr>
    <td colspan="2"><img src="apps/lander/src/screenshot-analytics.png" alt="Analytics"/></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><b>Analytics & Usage Tracking</b></td>
  </tr>
</table>

## Requirements

- [Bun](https://bun.sh) >= 1.2.8
- Claude API accounts (Free, Pro, or Team)

## Contributing

We welcome contributions! See [CONTRIBUTING.md](docs/contributing.md) for guidelines.

## License

MIT - See [LICENSE](LICENSE) for details

---

<p align="center">
  Built with ❤️ for developers who ship
</p>