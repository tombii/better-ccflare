# Technology Stack

**Analysis Date:** 2026-02-05

## Languages

**Primary:**
- TypeScript 5.9.3 - All source code (server, CLI, dashboard, packages)
- JavaScript - Configuration and build scripts
- JSX/TSX - React components in dashboard

**Secondary:**
- SQL - Database queries and migrations (SQLite)
- HTML/CSS - Dashboard UI (via React/Tailwind)

## Runtime

**Environment:**
- Bun 1.2.8+ - JavaScript/TypeScript runtime for server, CLI, and development
- Node.js 18+ - Engine requirement for CLI package (npm distribution)

**Package Manager:**
- Bun - Primary package manager and task runner
- npm - Used for CLI package distribution (published to npmjs.com)
- Lockfile: `bun.lock` (66KB, checked in)

## Frameworks

**Core:**
- Bun Web APIs - `serve()` for HTTP server in `apps/server/src/server.ts`
- React 19.2.1 - Dashboard UI framework in `packages/dashboard-web`
- React Router DOM 7.9.6 - Client-side routing for dashboard

**UI Components:**
- Radix UI - Headless component library (@radix-ui/react-*)
  - Dialog, Dropdown Menu, Label, Popover, Progress, Select, Separator, Slot, Switch, Tabs, Tooltip
- TailwindCSS 4.1.17 - Utility-first CSS framework
- class-variance-authority 0.7.1 - Component variant management
- tailwindcss-animate 1.0.7 - Animation utilities

**Charting/Visualization:**
- Recharts 3.1.0 - React charting library for analytics dashboard

**Build/Dev:**
- TypeScript 5.9.3 - Type checking (bunx tsc --noEmit)
- Biome 2.3.7 - Linting and formatting (bunx biome)
- Bun build - Native bundler for compiling CLI and server binaries

## Key Dependencies

**Critical:**
- @dqbd/tiktoken 1.0.22 - Token counting for Claude API in `packages/proxy`
- google-auth-library 10.5.0 - Google Cloud authentication for Vertex AI provider
- date-fns 4.1.0 - Date/time utilities for dashboard
- lucide-react 0.555.0 - Icon library for dashboard UI
- react-query @tanstack/react-query 5.90.11 - Server state management for dashboard API calls

**Internal:**
- @better-ccflare/* - Monorepo workspace packages (all interconnected)
- dotenv 17.2.3 - Environment variable loading for CLI

**HTTP:**
- Fetch API (native Bun) - HTTP requests throughout codebase
- No external HTTP client library (built-in fetch is used)

**Database:**
- bun:sqlite - SQLite integration (native Bun module)
- No ORM - Raw SQL with custom query builders in `packages/database`

## Configuration

**Environment:**
`.env` file (user creates, not checked in) or environment variables:
- `PORT` - Server port (default: 8080)
- `SSL_KEY_PATH` - Path to SSL private key (optional)
- `SSL_CERT_PATH` - Path to SSL certificate (optional)
- `LB_STRATEGY` - Load balancing strategy (default: "session")
- `LOG_LEVEL` - Log verbosity (DEBUG, INFO, WARN, ERROR; default: INFO)
- `LOG_FORMAT` - Log format (pretty or json; default: pretty)
- `DATA_RETENTION_DAYS` - Payload retention (default: 7)
- `REQUEST_RETENTION_DAYS` - Request metadata retention (default: 365)
- `BETTER_CCFLARE_DB_PATH` - Custom database path (default: ~/.config/better-ccflare/better-ccflare.db)

**Build:**
- `tsconfig.json` - TypeScript configuration
  - Target: esnext
  - Module: esnext
  - Strict mode enabled
  - Module resolution: bundler
  - Base URLs with path aliases (@better-ccflare/*)

**Type Checking:**
- `.npmrc` - npm package manager config (for CLI publishing)
- `biome.json` - Linting/formatting config (implicit, managed by .env and tsconfig)

## Platform Requirements

**Development:**
- Bun 1.2.8 or higher
- Node.js 18+ (for CLI package)
- bash/zsh shell
- Optional: systemd (for production service)

**Production:**
- Linux/macOS/Windows (compiled binaries available for:
  - linux-amd64
  - linux-arm64
  - macos-x86_64
  - macos-arm64
  - windows-x64)
- Port 8080 (configurable)
- SQLite database file storage (local filesystem)

**Deployment:**
- systemd service (referenced in docs, not in codebase)
- Single binary compilation supported for all major platforms

---

*Stack analysis: 2026-02-05*
