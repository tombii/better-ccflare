# Codebase Structure

**Analysis Date:** 2026-02-05

## Directory Layout

```
better-ccflare/
├── apps/                           # Executable applications
│   ├── cli/                        # CLI interface for account management and server startup
│   ├── server/                     # Express-like server configuration (used by CLI)
│   └── lander/                     # Landing page (marketing/documentation)
├── packages/                       # Shared libraries and domain logic
│   ├── core/                       # Core utilities, constants, models, pricing
│   ├── core-di/                    # Dependency injection container
│   ├── types/                      # Shared TypeScript types and interfaces
│   ├── database/                   # SQLite ORM and database operations
│   ├── config/                     # Configuration management (env, config file)
│   ├── logger/                     # Structured logging
│   ├── errors/                     # Custom error classes
│   ├── security/                   # Input validation and security utilities
│   ├── http-common/                # Shared HTTP utilities (headers, status codes)
│   ├── http-api/                   # REST API routes and handlers
│   ├── proxy/                      # Request proxying, token management, interceptors
│   ├── load-balancer/              # Load balancing strategies
│   ├── providers/                  # Provider implementations (Anthropic, OpenAI, Zai, etc.)
│   ├── oauth-flow/                 # OAuth authentication flow
│   ├── cli-commands/               # CLI command implementations
│   ├── agents/                     # Claude Code agent management
│   ├── ui-common/                  # React components shared between UI apps
│   ├── ui-constants/               # UI constants and styling
│   └── dashboard-web/              # React dashboard frontend
├── .planning/                      # GSD planning and analysis documents
├── package.json                    # Root workspace configuration (monorepo)
├── tsconfig.json                   # TypeScript configuration
└── biome.json                      # Biome formatter/linter configuration
```

## Directory Purposes

**apps/cli/**
- Purpose: CLI application entry point and command routing
- Contains: main.ts (argument parsing, command dispatch), package.json
- Key files: `src/main.ts` (1,152 lines - argument parsing and command routing)

**apps/server/**
- Purpose: HTTP server configuration and startup
- Contains: server.ts (Bun HTTP server, request routing, graceful shutdown), package.json
- Key files: `src/server.ts` (1,015 lines - server initialization, handler setup)

**packages/core/**
- Purpose: Core domain logic and utilities shared across all layers
- Contains: Constants, models, utilities, pricing, version tracking
- Key files:
  - `constants.ts` - HTTP status, network timeouts, buffer sizes
  - `models.ts` - Claude model IDs and display names
  - `pricing.ts` - Token cost calculations per provider
  - `version.ts` - Version tracking and changelog

**packages/database/**
- Purpose: Data persistence layer using SQLite
- Contains: Schema migrations, database operations, repository pattern
- Key files:
  - `database-operations.ts` (21,181 lines - all query methods, the most complex file)
  - `migrations.ts` (25,140 lines - schema setup and upgrades)
  - `repositories/` - Domain-specific repositories (account, request, stats, oauth)

**packages/types/**
- Purpose: Centralized TypeScript type definitions
- Contains: Account, Request, Provider, API, Stats interfaces
- Key files:
  - `account.ts` - Account and AccountRow types with usage data interfaces
  - `request.ts` - Request metadata and statistics types
  - `api-key.ts` - API key and auth types

**packages/http-api/**
- Purpose: REST API endpoint handlers
- Contains: APIRouter (main dispatcher), handler functions per domain
- Key files:
  - `router.ts` (15,403 lines - router initialization and request dispatching)
  - `handlers/accounts.ts` (53,525 lines - account CRUD, auth, re-authentication)
  - `handlers/analytics.ts` (18,616 lines - analytics and filtering)
  - `services/auth-service.ts` - Bearer token validation

**packages/proxy/**
- Purpose: Request forwarding, token management, response handling
- Contains: Proxy operations, token refresh, agent interceptor, stream handling
- Key files:
  - `proxy.ts` - Entry point, worker management
  - `handlers/proxy-operations.ts` (11,779 lines - core proxy logic with fallback)
  - `handlers/token-manager.ts` (12,534 lines - OAuth token lifecycle)
  - `handlers/token-health-monitor.ts` (9,442 lines - background health checks)
  - `handlers/agent-interceptor.ts` (13,277 lines - Claude Code CLI detection)
  - `auto-refresh-scheduler.ts` - Token refresh scheduling

**packages/load-balancer/**
- Purpose: Load balancing strategy implementations
- Contains: SessionStrategy for account rotation
- Key files:
  - `strategies/session.ts` - Session-based load balancing with time windows

**packages/providers/**
- Purpose: Provider-specific implementations
- Contains: Anthropic, OpenAI-compatible, Zai, NanoGPT, Minimax, etc.
- Pattern: Each provider implements canHandle(), getTokenRefreshUrl(), parseUsage()

**packages/config/**
- Purpose: Configuration management from environment and config files
- Contains: Config class with getter methods, precedence handling
- Key files: `src/index.ts` - Config class implementation

**packages/logger/**
- Purpose: Structured logging across application
- Contains: Logger class with context support
- Key files: `src/index.ts` - Logger implementation

**packages/cli-commands/**
- Purpose: CLI command implementations (add account, pause, resume, etc.)
- Contains: Command handlers, prompt adapters, formatting utilities
- Key files:
  - `commands/` - Individual command implementations
  - `prompts/` - User interaction handlers

**packages/security/**
- Purpose: Input validation and security checks
- Contains: Path validation, API key patterns, sanitization
- Key files: `src/` - Validation functions and patterns

**packages/oauth-flow/**
- Purpose: OAuth authentication flow handling
- Contains: OAuth state management, callback handling
- Key files: OAuth initialization and completion logic

**packages/dashboard-web/**
- Purpose: React frontend for web dashboard
- Contains: React components, pages, styling, state management
- Build output: `dist/` (embedded in server binary)

## Key File Locations

**Entry Points:**
- `apps/cli/src/main.ts` - CLI argument parser and dispatcher (1,152 lines)
- `apps/server/src/server.ts` - HTTP server initialization (1,015 lines)
- `packages/proxy/src/proxy.ts` - Proxy entry point with worker management

**Configuration:**
- `package.json` (root) - Workspace configuration and build scripts
- `tsconfig.json` - TypeScript compiler options
- `biome.json` - Code formatting and linting rules

**Core Logic:**
- `packages/database/src/database-operations.ts` - All database queries (21,181 lines)
- `packages/http-api/src/router.ts` - API routing (15,403 lines)
- `packages/http-api/src/handlers/accounts.ts` - Account management (53,525 lines)
- `packages/proxy/src/handlers/proxy-operations.ts` - Proxy logic (11,779 lines)
- `packages/proxy/src/handlers/token-manager.ts` - Token refresh (12,534 lines)
- `packages/proxy/src/handlers/agent-interceptor.ts` - Claude Code detection (13,277 lines)

**Testing:**
- `__tests__/` directories at package level (co-located with source)
- `*.test.ts` or `*.spec.ts` files

## Naming Conventions

**Files:**
- Handlers: `[domain]-[action]-handler.ts` (e.g., `account-add-handler.ts`)
- Utilities: `[domain]-utils.ts` or `[concern].ts` (e.g., `token-manager.ts`)
- Types: `[domain].ts` (e.g., `account.ts`)
- Constants: `constants.ts` (shared per package)
- Tests: `[source-file].test.ts` or `[concern].test.ts`

**Directories:**
- Feature domains: lowercase-with-hyphens (e.g., `cli-commands`, `http-api`)
- Subdirectories: lowercase-with-hyphens (e.g., `handlers/`, `repositories/`)

**Functions:**
- Command handlers: `handle[Subject][Action]` (e.g., `handleAddAccount`, `handleProxy`)
- Query methods: `get[Entity]`, `getAllAccounts`, `getAccount(id)`
- Mutations: `create[Entity]`, `update[Property]`, `delete[Entity]`
- Factories: `create[Object]Handler`, `new[ClassName]()`
- Utilities: camelCase with verb prefix (e.g., `validateApiKey`, `selectAccountsForRequest`)

**Classes:**
- Domain classes: PascalCase (e.g., `DatabaseOperations`, `APIRouter`, `Logger`)
- Strategy pattern: `[Name]Strategy` (e.g., `SessionStrategy`)
- Services: `[Domain]Service` (e.g., `AuthService`, `TokenHealthService`)
- Repositories: `[Entity]Repository` (e.g., `AccountRepository`)

**Types/Interfaces:**
- Types: PascalCase (e.g., `Account`, `RequestMeta`, `ProxyContext`)
- Configuration: `[Domain]Config` (e.g., `DatabaseConfig`, `RuntimeConfig`)
- Options: `[Function]Options` (e.g., `StartServerOptions`)

## Where to Add New Code

**New Feature - Complete Request Flow:**
1. Define types: `packages/types/src/[feature].ts`
2. Database: `packages/database/src/database-operations.ts` (query method)
3. Database: `packages/database/src/repositories/[feature].repository.ts` (new file if needed)
4. API handler: `packages/http-api/src/handlers/[feature].ts`
5. Router: Update `packages/http-api/src/router.ts` to register endpoint
6. Tests: `packages/http-api/src/handlers/__tests__/[feature].test.ts`

**New API Endpoint:**
1. Define handler: `packages/http-api/src/handlers/[domain].ts`
2. Register in router: `packages/http-api/src/router.ts`
3. Add to APIRouter.handlers map with path pattern
4. Add tests: `packages/http-api/src/handlers/__tests__/[domain].test.ts`

**New Provider:**
1. Implement: `packages/providers/src/[provider-name].provider.ts`
2. Register: `packages/providers/src/index.ts` (getProvider function)
3. Add account mode: CLI commands and types

**New Load Balancing Strategy:**
1. Implement: `packages/load-balancer/src/strategies/[strategy-name].ts`
2. Extend abstract strategy interface
3. Register in: Server initialization code

**New CLI Command:**
1. Implement: `packages/cli-commands/src/commands/[command].ts`
2. Export from: `packages/cli-commands/src/index.ts`
3. Register in: `apps/cli/src/main.ts` parseArgs and main switch

**Utilities - Shared across packages:**
- Common patterns: `packages/core/src/` (constants, validation, utils)
- HTTP specifics: `packages/http-common/src/`
- Security checks: `packages/security/src/`

**UI Components:**
- React components: `packages/ui-common/src/components/[component].tsx`
- Constants/styling: `packages/ui-constants/src/`
- Page routes: `packages/dashboard-web/src/pages/[page].tsx`

## Special Directories

**packages/proxy/src/handlers/__tests__/**
- Purpose: Tests for proxy request handling
- Generated: No
- Committed: Yes
- Contains: Security tests, OAuth feature tests, token refresh tests

**packages/database/src/repositories/**
- Purpose: Domain-specific database query organization
- Generated: No
- Committed: Yes
- Contains: AccountRepository, RequestRepository, StatsRepository, etc.

**packages/http-api/src/handlers/**
- Purpose: Separate handler implementation files per domain
- Generated: No
- Committed: Yes
- Contains: accounts.ts, analytics.ts, config.ts, requests.ts, etc. (one large file per domain)

**packages/dashboard-web/dist/**
- Purpose: Built React dashboard assets
- Generated: Yes (during build)
- Committed: No (.gitignored)
- Contains: Embedded in server binary as base64-encoded assets

**.planning/codebase/**
- Purpose: GSD analysis documents
- Generated: Yes (by GSD agents)
- Committed: Yes
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, etc.

**__tests__/ (root)**
- Purpose: Integration and system tests
- Generated: No
- Committed: Yes
- Pattern: Test files that span multiple packages

---

*Structure analysis: 2026-02-05*
