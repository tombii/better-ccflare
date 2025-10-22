# better-ccflare 🛡️

**Track Every Request. Go Low-Level. Never Hit Rate Limits Again.**

The ultimate Claude API proxy with intelligent load balancing across multiple accounts. Full visibility into every request, response, and rate limit.


https://github.com/user-attachments/assets/c859872f-ca5e-4f8b-b6a0-7cc7461fe62a


![better-ccflare Dashboard](apps/lander/src/screenshot-dashboard.png)

## Why better-ccflare?

- **🚀 Zero Rate Limit Errors** - Automatically distribute requests across multiple accounts
- **🤖 Supports z.ai coder plan** - Setup Claude and z.ai coder accounts and prioritize in which order they are used
- **🔗 Custom API Endpoints** - Configure custom endpoints for Anthropic and Zai accounts for enterprise deployments
- **☁️ OpenAI-Compatible Support** - Use OpenAI-compatible providers like OpenRouter, Together AI, and more with Claude API format
- **🔄 Smart Auto-Fallback** - Automatically switch back to preferred accounts when their rate limits reset
- **⚡ Auto-Refresh** - Automatically start new usage windows when rate limits reset
- **📊 Request-Level Analytics** - Track latency, token usage, and costs in real-time with optimized batch processing
- **🔍 Deep Debugging** - Full request/response logging and error traces
- **⚡ <10ms Overhead** - Minimal performance impact with lazy loading and request deduplication
- **💸 Free & Open Source** - Run it yourself, modify it, own your infrastructure

### Why this fork?

This project builds upon the excellent foundation of [snipeship/ccflare](https://github.com/snipeship/ccflare) with significant enhancements:

**🎯 Core Improvements:**
- **Enhanced Load Balancing** - Session-based load balancing with intelligent failover
- **Real-time Analytics Dashboard** - Beautiful web UI for monitoring usage and performance
- **Smart Rate Limit Management** - Auto-refresh and auto-fallback mechanisms
- **Multi-Provider Support** - Claude API, z.ai coder, and custom endpoints
- **Package Distribution** - Available via npm and bun for easy installation

**🛠️ Developer Experience:**
- **TUI Interface** - Interactive terminal-based account management
- **REST API** - Complete API for automation and integration
- **Cross-Platform Binary** - Pre-compiled binary works with Node.js or Bun
- **Comprehensive Logging** - Request/response tracking with searchable history
- **Database Integration** - SQLite for persistent storage and analytics

**📦 Distribution & Updates:**
- **npm/bun Registry** - Install with `npm install -g better-ccflare` or `bun install -g better-ccflare`
- **npx/bunx Support** - Run without installation: `npx better-ccflare` or `bunx better-ccflare`
- **Smart Update Detection** - Web UI detects package manager and shows appropriate update commands
- **Version Management** - Semantic versioning with automatic update notifications

**🏢 Production Ready:**
- **Enterprise Features** - Custom API endpoints, session management, advanced analytics
- **Performance Optimized** - <10ms overhead with request deduplication and caching
- **Reliability** - Automatic error recovery, circuit breakers, and health monitoring
- **Scalability** - Built for high-throughput production environments

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

### Run without installation (npx/bunx)

```bash
# Run with npx (downloads and executes latest version)
npx better-ccflare@latest

# Run with bunx (faster for bun users)
bunx better-ccflare@latest
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

# Add OpenAI-compatible provider (like OpenRouter)
better-ccflare --add-account openrouter --mode openai-compatible --priority 5

# Enable auto-fallback on your primary account (via API)
curl -X POST http://localhost:8080/api/accounts/$(curl -s http://localhost:8080/api/accounts | jq -r '.[0].id')/auto-fallback \
  -H "Content-Type: application/json" \
  -d '{"enabled": 1}'

# Configure custom endpoint for an account (via API)
curl -X POST http://localhost:8080/api/accounts/$(curl -s http://localhost:8080/api/accounts | jq -r '.[0].id')/custom-endpoint \
  -H "Content-Type: application/json" \
  -d '{"customEndpoint": "https://your-custom-api.anthropic.com"}'
```

### SSL/HTTPS Configuration

To enable HTTPS with better-ccflare, you'll need SSL certificates. Here are your options:

#### Option 1: Generate Self-Signed Certificates (Development/Local Use)

```bash
# Generate a self-signed certificate on the better-ccflare host
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=yourhostname"

# Start better-ccflare with SSL
export SSL_KEY_PATH=/path/to/key.pem
export SSL_CERT_PATH=/path/to/cert.pem
better-ccflare

# Or use command line flags
better-ccflare --ssl-key /path/to/key.pem --ssl-cert /path/to/cert.pem
```

**Trust the self-signed certificate on client machines:**

For self-signed certificates, you need to add the certificate to your system's trusted certificates:

- **Linux (Ubuntu/Debian):**
  ```bash
  # Copy cert.pem from the better-ccflare host to your client machine
  sudo cp cert.pem /usr/local/share/ca-certificates/better-ccflare.crt
  sudo update-ca-certificates
  ```

- **Linux (Arch/Manjaro):**
  ```bash
  # Copy cert.pem from the better-ccflare host to your client machine
  sudo cp cert.pem /etc/ca-certificates/trust-source/anchors/better-ccflare.crt
  sudo trust extract-compat
  ```

- **macOS:**
  ```bash
  # Copy cert.pem from the better-ccflare host to your client machine
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain cert.pem
  ```

- **Windows (PowerShell as Administrator):**
  ```powershell
  # Copy cert.pem from the better-ccflare host to your client machine
  Import-Certificate -FilePath cert.pem -CertStoreLocation Cert:\LocalMachine\Root
  ```

**Configure Claude Code to use the trusted certificate:**

After adding the certificate to your system's trusted store, configure your environment:

```bash
# Add to your ~/.bashrc or ~/.zshrc
export NODE_OPTIONS="--use-system-ca"
export ANTHROPIC_BASE_URL=https://yourhostname:8080
```

The `NODE_OPTIONS="--use-system-ca"` is **required** for Claude Code and other Node.js-based clients to use the system certificate store. Without this, Node.js will not trust your self-signed certificate even if it's in the system store.

#### Option 2: Use Production Certificates (Production/Remote Access)

If you're running better-ccflare on a server with a domain name, use Let's Encrypt or your certificate provider:

```bash
# Using Let's Encrypt certificates
export SSL_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
export SSL_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
better-ccflare

# Set the base URL to use HTTPS
export ANTHROPIC_BASE_URL=https://yourdomain.com:8080
```

With production certificates from trusted CAs, you don't need `NODE_OPTIONS="--use-system-ca"` as they are already trusted.

#### Troubleshooting SSL Issues

**Problem:** "Unable to connect to API due to poor internet connection" error even with `ANTHROPIC_BASE_URL` set

**Solutions:**
1. Verify the environment variable is set in the same shell/session:
   ```bash
   echo $ANTHROPIC_BASE_URL
   echo $NODE_OPTIONS
   ```

2. Test the SSL connection manually:
   ```bash
   # Should succeed without errors
   curl https://yourhostname:8080/health

   # If you see certificate errors, the cert isn't trusted yet
   curl -k https://yourhostname:8080/health  # -k bypasses cert check for testing
   ```

3. Verify the certificate is in the system store:
   ```bash
   # Linux
   ls -la /etc/ssl/certs/ | grep better-ccflare

   # macOS
   security find-certificate -a -c yourhostname -p /Library/Keychains/System.keychain
   ```

4. Ensure the hostname resolves correctly:
   ```bash
   ping yourhostname
   ```

5. Check that the server is actually running:
   ```bash
   curl -k https://yourhostname:8080/health
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

### ☁️ OpenAI-Compatible Support
- **Universal API Format** - Use OpenAI-compatible providers (OpenRouter, Together AI, etc.) with Claude API format
- **Automatic Format Conversion** - Seamless conversion between Anthropic and OpenAI request/response formats
- **Model Mapping** - Map Claude models (opus, sonnet, haiku) to equivalent OpenAI models
- **Streaming Support** - Full support for streaming responses from OpenAI-compatible providers
- **API Key Authentication** - Secure API key management for OpenAI-compatible providers
- **Cost Tracking** - Automatic cost calculation for usage monitoring and budgeting

## Documentation

Full documentation available in [`docs/`](docs/):
- [Getting Started](docs/index.md)
- [Architecture](docs/architecture.md)
- [API Reference](docs/api-http.md)
- [Configuration](docs/configuration.md)
- [Load Balancing Strategies](docs/load-balancing.md)
- [Auto-Fallback Guide](docs/auto-fallback.md)
- [Auto-Refresh Guide](docs/auto-refresh.md)
- [OpenAI-Compatible Providers](docs/providers.md)

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

**For installation:**
- **npm** or **bun** package manager
- **Node.js** >= 18.0.0 (when installed via npm)
- **Bun** >= 1.2.8 (when installed via bun or running from source)

**For usage:**
- Claude API accounts (Free, Pro, or Team) or z.ai code plan accounts

## Acknowledgments

Inspired by [snipeship/ccflare](https://github.com/snipeship/ccflare) - thanks for the original idea and implementation!

**Special thanks to our contributors:**
- [@anonym-uz](https://github.com/anonym-uz) - Critical auto-pause bug fix, analytics performance optimizations, request body truncation, and incremental vacuum implementation
- [@makhweeb](https://github.com/makhweeb) - Enhanced request handling and analytics improvements

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
