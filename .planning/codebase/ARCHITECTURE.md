# Architecture

**Analysis Date:** 2026-02-05

## Pattern Overview

**Overall:** Load-Balancing Proxy with Multi-Account Support

**Key Characteristics:**
- Request routing across multiple account providers to distribute load
- Session-based load balancing strategy with configurable persistence
- Multi-provider support (Anthropic, OpenAI-compatible, NanoGPT, Zai, Minimax, etc.)
- Real-time usage monitoring and analytics
- Token refresh management with auto-refresh scheduling
- Database-driven account and configuration management

## Layers

**Server Layer:**
- Purpose: HTTP request routing and response handling
- Location: `apps/server/src/server.ts`
- Contains: Bun server configuration, dashboard asset serving, graceful shutdown
- Depends on: APIRouter, ProxyContext, authentication services
- Used by: CLI and standalone deployment

**HTTP API Layer:**
- Purpose: RESTful API endpoints for account management, analytics, configuration
- Location: `packages/http-api/src/`
- Contains: APIRouter (main handler), endpoint-specific handlers in `handlers/`
- Depends on: Database layer, authentication service
- Used by: Server layer, dashboard frontend

**Proxy Layer:**
- Purpose: Request interception, account selection, provider delegation
- Location: `packages/proxy/src/`
- Contains: Proxy operations, token management, agent interceptor, stream handling
- Depends on: Load balancer strategy, account selector, token manager
- Used by: Server layer for `/v1/*` requests

**Load Balancer Layer:**
- Purpose: Account selection strategy based on session state
- Location: `packages/load-balancer/src/strategies/`
- Contains: SessionStrategy (primary), strategy implementations
- Depends on: Database operations for session state
- Used by: Proxy layer for account selection

**Database Layer:**
- Purpose: Persistent storage for accounts, requests, statistics, OAuth sessions
- Location: `packages/database/src/`
- Contains: DatabaseOperations class, repositories, migrations, performance indexes
- Depends on: SQLite (bun:sqlite)
- Used by: All layers requiring persistence

**Token Management Layer:**
- Purpose: OAuth token refresh, expiration tracking, health monitoring
- Location: `packages/proxy/src/handlers/token-manager.ts`, `token-health-monitor.ts`
- Contains: Token refresh logic, health checks, auto-refresh scheduling
- Depends on: Providers for token refresh endpoints
- Used by: Proxy layer before each request

**Type System:**
- Purpose: Shared type definitions across packages
- Location: `packages/types/src/`
- Contains: Account, Request, Provider, API, Stats types
- Used by: All packages

**Core Utilities:**
- Purpose: Shared constants, error types, validation, pricing
- Location: `packages/core/src/`
- Contains: Constants (HTTP status, network timeouts), model mappings, validation, pricing calculations
- Used by: All packages

## Data Flow

**Request Processing:**

1. HTTP request arrives at server (`apps/server/src/server.ts`)
2. APIRouter routes to endpoint handler or proxy
3. For `/v1/*` requests, ProxyContext flows through:
   - AuthService validates API key (blocks unauthenticated requests)
   - handleProxy() entry point in `packages/proxy/src/`
   - Account selection via SessionStrategy (load balancer)
   - Token validation and refresh (TokenManager)
   - Agent interceptor modifies request if needed (Claude CLI detection)
   - Request forwarded to provider with appropriate headers
   - Response processed and streamed back
   - Usage data extracted and queued to worker

**Account Lifecycle:**

1. CLI: `--add-account` → addAccount() in `packages/cli-commands/src/`
2. Database insertion via AccountRepository (`packages/database/src/repositories/account.repository.ts`)
3. Server startup loads accounts into memory
4. Usage polling started per account via UsageCache
5. Token refresh scheduled if expiring soon (AutoRefreshScheduler)
6. Request counts and rate limit status tracked per request

**State Management:**

- **In-Memory:** Session state, refresh cache (refreshInFlight Map)
- **Database:** Account credentials, request history, statistics, OAuth sessions
- **Worker Thread:** Usage statistics aggregation (post-processor.worker.ts)

**Session-Based Load Balancing:**

1. Each request creates/updates a session key (account_id + session window)
2. Strategy tracks request count per session
3. When session threshold exceeded or time expired, account rotates
4. Same client can resume previous session if within duration window

## Key Abstractions

**ProxyContext:**
- Purpose: Encapsulates all runtime state for request processing
- Location: `packages/proxy/src/handlers/proxy-types.ts`
- Includes: Strategy, dbOps, runtime config, provider, refreshInFlight cache, async writer, usage worker
- Used by: All proxy handlers

**DatabaseOperations:**
- Purpose: Unified interface for all database queries and mutations
- Location: `packages/database/src/database-operations.ts`
- Methods: getAccount, getAllAccounts, createRequest, updateStats, etc.
- Pattern: Synchronous queries with retry logic and transaction support

**AuthService:**
- Purpose: Request authentication via API keys
- Location: `packages/http-api/src/services/auth-service.ts`
- Validates: Authorization header, API key enabled/disabled status, rate limiting
- Returns: AuthResult with isAuthenticated, apiKeyId, apiKeyName

**Provider:**
- Purpose: Abstract provider implementation for different APIs
- Location: `packages/providers/src/`
- Methods: canHandle(path), getTokenRefreshUrl, parseUsage, etc.
- Implementations: AnthropicProvider, OpenAIProvider, ZaiProvider, NanoGPTProvider, etc.

**RequestMetadata:**
- Purpose: Track individual request through system
- Location: `packages/types/src/request.ts`
- Includes: id, timestamp, method, path, account used, tokens consumed
- Flows to: Database for analytics, Worker for summaries

**LoadBalancingStrategy:**
- Purpose: Account selection algorithm
- Location: `packages/load-balancer/src/strategies/`
- Methods: selectAccount(accounts, context), recordRequest(accountId)
- State: Persisted in database for cross-server consistency

## Entry Points

**CLI Entry Point:**
- Location: `apps/cli/src/main.ts`
- Triggers: `bun run cli` or `bun better-ccflare`
- Responsibilities: Parse arguments, initialize database, route to command handlers, handle server startup

**Server Entry Point:**
- Location: `apps/server/src/server.ts`
- Triggers: import as module in CLI or standalone execution
- Responsibilities: Initialize all services, configure Bun server, handle dashboard, manage graceful shutdown

**Request Entry Point:**
- Location: `apps/server/src/server.ts` (fetch handler in serve config)
- Triggers: All HTTP requests to server
- Flow: API routes → APIRouter, Dashboard routes → static serving, Proxy routes → handleProxy

**API Endpoints:**
- GET `/api/accounts` → List all accounts
- POST `/api/accounts` → Add account
- GET `/api/stats` → View statistics
- POST `/api/config` → Update configuration
- GET `/health` → Health check

**Proxy Endpoints:**
- POST `/v1/*` → Forward Claude API requests with load balancing

## Error Handling

**Strategy:** Layer-specific error classes with context propagation

**Patterns:**

- **ValidationError:** Input validation failures, logged with field context
- **RateLimitError:** Account rate limited, initiates fallback or retry
- **TokenRefreshError:** Token refresh failed, marks account expired
- **ProviderError:** Provider returned error, may retry or fallback
- **OAuthError:** OAuth flow failures, requires re-authentication
- **ServiceUnavailableError:** Provider temporarily unavailable, triggers fallback

**Flow:**
1. Error caught at origin (proxy handler, API endpoint)
2. Logged with context (accountId, userId, timestamp)
3. Converted to HTTP response (401, 429, 500, etc.)
4. Forwarded to client with safe error message
5. For recoverable errors (rate limit, auth), initiates fallback account or retry

## Cross-Cutting Concerns

**Logging:**
- Package: `packages/logger/src/index.ts`
- Pattern: Logger("ModuleName") at module initialization
- Levels: INFO, DEBUG, WARN, ERROR
- Contextual: Includes accountId, userId, timestamp, error stack

**Validation:**
- Package: `packages/core/src/validation.ts`
- Pattern: Schema-based validation for inputs, configs, API keys
- Sanitization: Prevents path traversal, SQL injection, XSS

**Authentication:**
- Location: `packages/http-api/src/services/auth-service.ts`
- Pattern: Bearer token in Authorization header, database lookup
- Rate limiting: Per API key, checked on each request

**Usage Tracking:**
- Location: `packages/proxy/src/` handlers + worker thread
- Pattern: Request counts per account, token consumption per model
- Storage: Database for history, in-memory for real-time stats

**Token Refresh:**
- Location: `packages/proxy/src/handlers/token-manager.ts`
- Pattern: Check expiration before request, refresh if needed
- Auto-refresh: Scheduled 10 minutes before expiration
- Health monitoring: Background checks every 5 minutes

**Database Transactions:**
- Pattern: Synchronous, no transaction API in Bun's sqlite
- Consistency: Single-threaded SQLite with WAL mode for concurrency
- Retry: Automatic retry with exponential backoff on SQLITE_BUSY

---

*Architecture analysis: 2026-02-05*
