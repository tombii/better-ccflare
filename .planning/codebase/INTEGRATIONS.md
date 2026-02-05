# External Integrations

**Analysis Date:** 2026-02-05

## APIs & External Services

**Anthropic OAuth API:**
- Primary integration point for Claude API access
- OAuth endpoints:
  - Authorization: `https://console.anthropic.com/oauth/authorize` (Console mode)
  - Authorization: `https://claude.ai/oauth/authorize` (Claude CLI mode, via oauth-flow)
  - Token exchange: `https://console.anthropic.com/v1/oauth/token`
  - Usage endpoint: `https://api.anthropic.com/api/oauth/usage`
- SDK/Client: Custom fetch-based implementation
  - Location: `packages/providers/src/providers/anthropic/oauth.ts`
  - Uses PKCE flow for OAuth 2.0 authorization
- Auth: OAuth 2.0 access/refresh tokens stored in database
- Scopes: org:create_api_key, user:profile, user:inference

**Anthropic API Key (Console Mode):**
- Alternative auth method for API key-based access
- Endpoint: `https://api.anthropic.com` (proxied via this service)
- Used for accounts created in console.anthropic.com
- Auth: Direct API key header (Authorization: Bearer)

**Zai Provider:**
- Anthropic-compatible provider for z.ai service
- Endpoint: `https://api.z.ai/api/anthropic`
- SDK/Client: Custom Anthropic-compatible wrapper
  - Location: `packages/providers/src/providers/zai/provider.ts`
- Auth: API key via x-api-key header
- Rate limit parsing: Custom JSON response body parsing

**Minimax Provider:**
- Anthropic-compatible provider for Minimax API
- Endpoint: `https://api.minimax.io/anthropic`
- SDK/Client: Custom Anthropic-compatible wrapper
  - Location: `packages/providers/src/providers/minimax/provider.ts`
- Auth: API key via x-api-key header
- Model mapping: Forces all models to MiniMax-M2

**NanoGPT Provider:**
- Anthropic-compatible provider
- Supports custom endpoint URLs
- SDK/Client: Custom wrapper with pricing calculation
  - Location: `packages/providers/src/providers/nanogpt/provider.ts`
- Auth: API key via x-api-key header
- Usage fetching: `packages/providers/src/nanogpt-usage-fetcher.ts`

**Vertex AI (Google Cloud):**
- Google Cloud AI provider
- Supports Anthropic API compatibility
- SDK/Client: google-auth-library for authentication
  - Location: `packages/providers/src/providers/vertex-ai/provider.ts`
- Auth: Service account credentials (Google Cloud application default credentials)

**OpenAI-Compatible Providers:**
- Generic OpenAI API-compatible endpoint support
- SDK/Client: Custom OpenAI-compatible wrapper
  - Location: `packages/providers/src/providers/openai/provider.ts`
- Auth: API key via Authorization header (Bearer)
- Features: Model mapping, tool/function call support

**Anthropic-Compatible Custom Endpoints:**
- Generic Anthropic API-compatible endpoint factory
- Supports arbitrary custom endpoints (e.g., private Claude deployments)
- SDK/Client: Configurable provider factory
  - Location: `packages/providers/src/providers/anthropic-compatible/factory.ts`
- Auth: Configurable (API key via x-api-key or Authorization header)
- Model mapping: Supports per-account model name transformations

## Data Storage

**Databases:**
- SQLite (via bun:sqlite native module)
  - Connection: Local file at `~/.config/better-ccflare/better-ccflare.db` (configurable)
  - Set via: `BETTER_CCFLARE_DB_PATH` environment variable
  - Client: Bun's native `Database` class from `bun:sqlite`
  - Location: `packages/database/src/database-operations.ts`

**Database Tables:**
- `accounts` - Stored OAuth credentials, API keys, account metadata
- `oauth_sessions` - OAuth flow state during authentication
- `requests` - API request metadata (method, path, status, timing)
- `payloads` - Request/response body storage for debugging
- `stats` - Aggregated usage statistics per account
- `agent_preferences` - User-configured agent routing preferences
- `api_keys` - Generated API keys for proxy authentication
- `strategy_store` - Session strategy state (5-hour account windows)

**File Storage:**
- Local filesystem only
- No cloud storage integrations

**Caching:**
- In-memory usage cache in `packages/providers`
  - Location: `packages/providers/src/usage-fetcher.ts`
- Token refresh state tracking
- No Redis or external caching service

## Authentication & Identity

**Auth Provider:**
- Custom OAuth 2.0 implementation with PKCE
  - Location: `packages/providers/src/oauth/`
  - Base implementation: `packages/providers/src/oauth/base-oauth-provider.ts`

**Account Types Supported:**
1. Claude OAuth (claude-oauth) - via claude.ai login
2. Console API Key (console) - from console.anthropic.com
3. Zai API Key (zai)
4. Minimax API Key (minimax)
5. NanoGPT API Key (nanogpt)
6. Vertex AI Service Account (vertex-ai)
7. OpenAI-compatible API Key (openai-compatible)
8. Anthropic-compatible API Key (anthropic-compatible)

**Token Management:**
- OAuth token refresh via `refreshToken()` provider method
- Auto-refresh scheduler: `packages/proxy/src/auto-refresh-scheduler.ts`
- Token health checks: `packages/proxy/src/handlers/token-health.ts`
- Token expiration tracking in database

**Proxy Authentication:**
- API keys generated locally and stored in database
  - Location: `packages/database/src/repositories/api-key.repository.ts`
- Bearer token authentication required for proxy API access

## Monitoring & Observability

**Error Tracking:**
- None detected - no Sentry, Datadog, or error tracking service integration

**Logs:**
- Console-based logging (stdout/stderr)
- Structured JSON logging support via LOG_FORMAT env var
  - Location: `packages/logger/src/index.ts`
- Log levels: DEBUG, INFO, WARN, ERROR (configurable via LOG_LEVEL)
- File-based logging: `packages/logger/src/file-writer.ts` (writes to local filesystem)

**Analytics:**
- In-memory event tracking and streaming
  - Location: `packages/http-api/src/handlers/analytics.ts`
- Dashboard API endpoint: `GET /api/analytics` with filters
- Request streaming: `packages/http-api/src/handlers/requests-stream.ts`
- No external analytics service

**Observability Signals:**
- Request metrics collected: method, path, status, latency, tokens used
- Rate limit state tracking per account
- Health checks: `packages/http-api/src/handlers/health.ts`
- System info: `packages/http-api/src/handlers/system.ts`

## CI/CD & Deployment

**Hosting:**
- Self-hosted (single binary or service)
- No cloud platform integration (AWS, GCP, Azure references)
- systemd service support (manual setup, not in codebase)

**CI Pipeline:**
- GitHub Actions (inferred from workflow directory, not analyzed in detail)
- Auto-rerun workflow for failed runs
- npm publishing for CLI package
- Version bumping automation

## Environment Configuration

**Required env vars:**
- None strictly required (all have defaults)
- `PORT` - Server port (recommended to set)
- `BETTER_CCFLARE_DB_PATH` - Database path (recommended for custom deployments)

**Optional env vars for features:**
- `SSL_KEY_PATH` + `SSL_CERT_PATH` - TLS/HTTPS support
- `LOG_LEVEL` - Debugging
- `LOG_FORMAT` - Machine-readable logs
- `LB_STRATEGY` - Load balancing algorithm selection
- `DATA_RETENTION_DAYS` - Data cleanup
- `REQUEST_RETENTION_DAYS` - Metadata retention

**Secrets location:**
- Database: OAuth tokens and API keys stored in encrypted/hashed forms in SQLite
- No .env file checked in (template: `.env.example`)
- No external secrets manager integration (Vault, AWS Secrets Manager, etc.)

## Webhooks & Callbacks

**Incoming:**
- OAuth callback endpoint: `POST /api/oauth/callback`
  - Location: `packages/http-api/src/handlers/oauth.ts`
  - Receives authorization code from Anthropic OAuth providers

**Outgoing:**
- No outgoing webhooks detected
- No event subscriptions to external services

## Rate Limiting & Throttling

**API Rate Limiting:**
- Tracked per account via provider's response headers
- Soft limits (warnings) vs hard limits (blocks)
- Status classifications: allowed_warning, queueing_soft, queueing_hard, rate_limited, blocked, payment_required
- Location: `packages/providers/src/providers/anthropic/provider.ts`

**Session Management:**
- 5-hour session windows per account (Claude API standard)
- Session state: `packages/load-balancer/src/session-strategy.ts`
- Automatic account rotation within windows

---

*Integration audit: 2026-02-05*
