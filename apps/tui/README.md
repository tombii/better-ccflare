# better-ccflare 🛡️

**Track Every Request. Go Low-Level. Never Hit Rate Limits Again.**

The ultimate Claude API proxy with intelligent load balancing across multiple accounts. Full visibility into every request, response, and rate limit.


https://github.com/user-attachments/assets/c859872f-ca5e-4f8b-b6a0-7cc7461fe62a


![better-ccflare Dashboard](apps/lander/src/screenshot-dashboard.png)

## Why better-ccflare?

- **🚀 Zero Rate Limit Errors** - Automatically distribute requests across multiple accounts
- **🤖 Supports z.ai coder plan** - Setup Claude and z.ai coder accounts and prioritize in which order they are used
- **🔗 Custom API Endpoints** - Configure custom endpoints for Anthropic and Zai accounts for enterprise deployments
- **🔄 Smart Auto-Fallback** - Automatically switch back to preferred accounts when their rate limits reset
- **⚡ Auto-Refresh** - Automatically start new usage windows when rate limits reset
- **📊 Request-Level Analytics** - Track latency, token usage, and costs in real-time with optimized batch processing
- **🔍 Deep Debugging** - Full request/response logging and error traces
- **⚡ <10ms Overhead** - Minimal performance impact with lazy loading and request deduplication
- **💸 Free & Open Source** - Run it yourself, modify it, own your infrastructure

## Quick Start

### Install via npm

```bash
npm install -g better-ccflare

# Start better-ccflare (TUI + Server)
better-ccflare
```

### Install via bun

```bash
bun install -g better-ccflare

# Start better-ccflare (TUI + Server)
better-ccflare
```

### Install from source

```bash
# Clone and install
git clone https://github.com/tombii/better-ccflare
cd better-ccflare
bun install

# Start better-ccflare (TUI + Server)
bun run better-ccflare
```

## Configure Claude SDK

```bash
# Set the base URL to point to better-ccflare
export ANTHROPIC_BASE_URL=http://localhost:8080

# Add multiple accounts with priorities
better-ccflare --add-account primary --mode max --tier 20 --priority 0
better-ccflare --add-account secondary --mode max --tier 20 --priority 10

# Enable auto-fallback on your primary account (via API)
curl -X POST http://localhost:8080/api/accounts/$(curl -s http://localhost:8080/api/accounts | jq -r '.[0].id')/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

# Configure custom endpoint for an account (via API)
curl -X POST http://localhost:8080/api/accounts/$(curl -s http://localhost:8080/api/accounts | jq -r '.[0].id')/custom-endpoint \
  -H "Content-Type: application/json" \
  -d '{"customEndpoint": "https://your-custom-api.anthropic.com"}'
```

## Features

### 🎯 Intelligent Load Balancing
- **Session-based** - Maintain conversation context (5hr sessions)
- **Auto-fallback** - Automatically switch back to higher priority accounts when their usage windows reset
- **Auto-refresh** - Automatically start new usage windows when they reset

### 📈 Real-Time Analytics
- Token usage tracking per request with optimized batch processing
- Response time monitoring with intelligent caching
- Rate limit detection and warnings
- Cost estimation and budgeting
- Request deduplication for improved performance
- Lazy-loaded analytics components for faster initial load

### 🛠️ Developer Tools
- Interactive TUI (`bun run better-ccflare`)
- Web dashboard (`http://localhost:8080/dashboard`)
- CLI for account management
- REST API for automation

### 🔒 Production Ready
- Automatic failover between accounts
- OAuth token refresh handling
- SQLite database for persistence
- Configurable retry logic
- Custom endpoint support for enterprise deployments
- Enhanced performance with request batching and caching

## Documentation

Full documentation available in [`docs/`](docs/):
- [Getting Started](docs/index.md)
- [Architecture](docs/architecture.md)
- [API Reference](docs/api-http.md)
- [Configuration](docs/configuration.md)
- [Load Balancing Strategies](docs/load-balancing.md)
- [Auto-Fallback Guide](docs/auto-fallback.md)
- [Auto-Refresh Guide](docs/auto-refresh.md)

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
- Claude API accounts (Free, Pro, or Team) or z.ai code plan accounts

## Acknowledgments

Inspired by [snipeship/ccflare](https://github.com/snipeship/ccflare) - thanks for the original idea and implementation!

## Contributing

We welcome contributions! See [CONTRIBUTING.md](docs/contributing.md) for guidelines.

## License

MIT - See [LICENSE](LICENSE) for details

---

<p align="center">
  Built with ❤️ for developers who ship
</p>

[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)
