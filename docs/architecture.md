# Claudeflare Architecture Documentation

## Overview

Claudeflare is a sophisticated load balancer proxy system designed to distribute requests across multiple OAuth accounts for AI services (currently focused on Anthropic's Claude API). It prevents rate limiting by intelligently routing requests through different authenticated accounts using various load balancing strategies.

The system is built with a modular, microservices-inspired architecture using TypeScript and Bun runtime, emphasizing separation of concerns, extensibility, and real-time monitoring capabilities.

## System Overview

```mermaid
graph LR
    subgraph "User Interfaces"
        UI1[Web Dashboard]
        UI2[CLI]
        UI3[TUI]
        UI4[API Clients]
    end
    
    subgraph "Claudeflare Core"
        LB[Load Balancer]
        PROXY[Proxy Engine]
        AUTH[OAuth Manager]
        MON[Monitoring]
    end
    
    subgraph "Data Storage"
        DB[(SQLite DB)]
        LOGS[Log Files]
        CFG[Config]
    end
    
    subgraph "External Services"
        CLAUDE[Claude API]
        OAUTH[OAuth Provider]
    end
    
    UI1 --> LB
    UI2 --> LB
    UI3 --> LB
    UI4 --> LB
    
    LB --> PROXY
    PROXY --> AUTH
    AUTH --> OAUTH
    PROXY --> CLAUDE
    
    LB --> DB
    PROXY --> DB
    MON --> DB
    MON --> LOGS
    LB --> CFG
```

## High-Level Architecture Diagram

```mermaid
graph TB
    %% Client Layer
    subgraph "Client Applications"
        CA[Client Apps]
        CLI[CLI Tool<br/>apps/cli]
        TUI[TUI Interface<br/>apps/tui]
        WEB[Web Dashboard<br/>packages/dashboard-web]
    end

    %% API Gateway Layer
    subgraph "Claudeflare Server"
        SERVER[HTTP Server<br/>apps/server]
        
        subgraph "Request Processing"
            ROUTER[API Router<br/>packages/http-api]
            PROXY[Proxy Handler<br/>packages/proxy]
        end
        
        subgraph "Core Services"
            LB[Load Balancer<br/>packages/load-balancer]
            PROV[Provider Registry<br/>packages/providers]
            AUTH[OAuth Manager]
            DI[DI Container<br/>packages/core-di]
            CFG[Config<br/>packages/config]
        end
        
        subgraph "Data Layer"
            DB[Database Operations<br/>packages/database]
            LOGGER[Logger<br/>packages/logger]
        end
    end

    %% External Services
    subgraph "External"
        CLAUDE[Claude API]
        OAUTH[OAuth Provider]
    end

    %% Storage
    SQLITE[(SQLite Database)]
    LOGS[Log Files]
    CONFIG[Config Files]

    %% Connections
    CA -->|HTTP/HTTPS| SERVER
    CLI -->|Commands| SERVER
    TUI -->|API Calls| SERVER
    WEB -->|Embedded in| SERVER
    
    SERVER --> ROUTER
    SERVER --> DI
    DI --> CFG
    CFG --> CONFIG
    ROUTER --> PROXY
    ROUTER -->|Health/Stats/Config| DB
    
    PROXY --> LB
    LB -->|Select Account| DB
    PROXY --> PROV
    PROV --> AUTH
    
    PROXY -->|Forward Request| CLAUDE
    AUTH -->|Token Refresh| OAUTH
    
    DB --> SQLITE
    LOGGER --> LOGS
    LOGGER --> DB
```

## Component Architecture

### Project Structure

The project is organized as a Bun monorepo with clear separation of concerns:

```
claudeflare/
├── apps/                    # Deployable applications
│   ├── cli/                # Command-line interface
│   ├── lander/            # Static landing page
│   ├── server/            # Main HTTP server
│   └── tui/               # Terminal UI (Ink-based)
├── packages/              # Shared libraries
│   ├── cli-commands/      # CLI command implementations
│   ├── config/            # Configuration management
│   ├── core/              # Core utilities and types
│   ├── core-di/           # Dependency injection
│   ├── dashboard-web/     # React dashboard
│   ├── database/          # SQLite operations
│   ├── http-api/          # REST API handlers
│   ├── load-balancer/     # Load balancing strategies
│   ├── logger/            # Logging utilities
│   ├── providers/         # AI provider integrations
│   ├── proxy/             # Request proxy logic
│   ├── tui-core/          # TUI screen components
│   └── types/             # Shared TypeScript types
```

### 1. Server Application (`apps/server`)

The main HTTP server that orchestrates all components:

```mermaid
graph LR
    subgraph "Server Initialization"
        START[Server Start]
        DI[DI Container Setup]
        DB_INIT[Database Init]
        STRAT[Strategy Init]
        ROUTES[Route Setup]
    end
    
    START --> DI
    DI --> DB_INIT
    DB_INIT --> STRAT
    STRAT --> ROUTES
    
    subgraph "Request Flow"
        REQ[Incoming Request]
        API_CHECK{API Route?}
        DASH_CHECK{Dashboard?}
        PROXY_CHECK{Proxy Route?}
        
        API_RESP[API Response]
        DASH_RESP[Dashboard HTML]
        PROXY_RESP[Proxy Response]
        NOT_FOUND[404 Response]
    end
    
    REQ --> API_CHECK
    API_CHECK -->|Yes| API_RESP
    API_CHECK -->|No| DASH_CHECK
    DASH_CHECK -->|Yes| DASH_RESP
    DASH_CHECK -->|No| PROXY_CHECK
    PROXY_CHECK -->|Yes| PROXY_RESP
    PROXY_CHECK -->|No| NOT_FOUND
```

**Key Responsibilities:**
- HTTP server setup using Bun's native server
- Dependency injection container management
- Route handling delegation
- Static asset serving for dashboard
- Graceful shutdown coordination
- Strategy hot-reloading based on configuration changes

### 2. Load Balancer Package (`packages/load-balancer`)

Implements multiple load balancing strategies:

```mermaid
classDiagram
    class LoadBalancingStrategy {
        <<interface>>
        +select(accounts: Account[], meta: RequestMeta): Account[]
        +initialize?(store: StrategyStore): void
    }
    
    class RoundRobinStrategy {
        -cursor: number
        +select(accounts, meta): Account[]
    }
    
    class LeastRequestsStrategy {
        +select(accounts, meta): Account[]
    }
    
    class SessionStrategy {
        -sessionDurationMs: number
        -store: StrategyStore
        +select(accounts, meta): Account[]
        +initialize(store): void
    }
    
    class WeightedStrategy {
        +select(accounts, meta): Account[]
    }
    
    class WeightedRoundRobinStrategy {
        -currentIndex: number
        +select(accounts, meta): Account[]
    }
    
    LoadBalancingStrategy <|.. RoundRobinStrategy
    LoadBalancingStrategy <|.. LeastRequestsStrategy
    LoadBalancingStrategy <|.. SessionStrategy
    LoadBalancingStrategy <|.. WeightedStrategy
    LoadBalancingStrategy <|.. WeightedRoundRobinStrategy
```

**Strategy Descriptions:**
- **RoundRobin**: Distributes requests evenly across all available accounts
- **LeastRequests**: Prioritizes accounts with the lowest request count
- **Session**: Maintains sticky sessions for a configured duration (default 5 hours)
- **Weighted**: Considers account tier when distributing load
- **WeightedRoundRobin**: Round-robin with tier-based weighting

### 3. Provider Package (`packages/providers`)

Manages AI service providers with extensible architecture:

```mermaid
graph TB
    subgraph "Provider System"
        REG[Provider Registry]
        BASE[Base Provider]
        
        subgraph "Provider Implementations"
            ANTH[Anthropic Provider]
            OAUTH_PROV[OAuth Provider]
        end
        
        subgraph "Provider Interface"
            HANDLE[canHandle()]
            BUILD[buildUrl()]
            PREP[prepareHeaders()]
            PARSE[parseRateLimit()]
            PROC[processResponse()]
            USAGE[extractUsageInfo()]
            TIER[extractTierInfo()]
        end
    end
    
    REG -->|Manages| BASE
    BASE -->|Implements| ANTH
    ANTH -->|Uses| OAUTH_PROV
    ANTH --> HANDLE
    ANTH --> BUILD
    ANTH --> PREP
    ANTH --> PARSE
    ANTH --> PROC
    ANTH --> USAGE
    ANTH --> TIER
```

**Provider Features:**
- Provider registration and discovery
- OAuth token management with PKCE flow
- Rate limit parsing and tracking
- Usage metrics extraction
- Account tier detection
- Extensible for additional AI providers

### 4. Database Package (`packages/database`)

SQLite-based persistence layer:

```mermaid
erDiagram
    accounts {
        text id PK
        text name
        text provider
        text api_key
        text refresh_token
        text access_token
        integer expires_at
        integer created_at
        integer last_used
        integer request_count
        integer total_requests
        integer account_tier
        integer rate_limited_until
        integer session_start
        integer session_request_count
        integer paused
        text rate_limit_status
        integer rate_limit_reset
        integer rate_limit_remaining
    }
    
    requests {
        text id PK
        integer timestamp
        text method
        text path
        text account_used FK
        integer status_code
        boolean success
        text error_message
        integer response_time_ms
        integer failover_attempts
        text model
        integer input_tokens
        integer output_tokens
        integer cache_read_input_tokens
        integer cache_creation_input_tokens
        real cost_usd
    }
    
    request_payloads {
        text id PK
        text json
    }
    
    accounts ||--o{ requests : "handles"
    requests ||--|| request_payloads : "has payload"
```

**Database Operations:**
- Account CRUD operations
- Request logging and analytics
- Rate limit tracking
- Session management
- Usage statistics
- Migration system for schema evolution

### 5. Proxy Package (`packages/proxy`)

Core request forwarding logic:

```mermaid
stateDiagram-v2
    [*] --> ValidateRequest
    ValidateRequest --> CheckProvider: Valid
    ValidateRequest --> Error400: Invalid
    
    CheckProvider --> GetAccounts
    GetAccounts --> NoAccounts: Empty
    GetAccounts --> TryAccount: Has Accounts
    
    NoAccounts --> ForwardUnauthenticated
    
    TryAccount --> CheckToken
    CheckToken --> RefreshToken: Expired
    CheckToken --> ForwardRequest: Valid
    RefreshToken --> ForwardRequest: Success
    RefreshToken --> NextAccount: Failed
    
    ForwardRequest --> CheckRateLimit
    CheckRateLimit --> MarkRateLimited: Limited
    CheckRateLimit --> ExtractUsage: OK
    MarkRateLimited --> NextAccount
    
    ExtractUsage --> UpdateStats
    UpdateStats --> ReturnResponse
    
    NextAccount --> TryAccount: More Accounts
    NextAccount --> AllFailed: No More
    
    ForwardUnauthenticated --> ReturnResponse
    AllFailed --> Error503
    Error400 --> [*]
    Error503 --> [*]
    ReturnResponse --> [*]
```

**Proxy Features:**
- Request validation and routing
- Token refresh with stampede prevention
- Retry logic with exponential backoff
- Rate limit detection and account marking
- Usage tracking and cost calculation
- Request/response payload logging

### 6. HTTP API Package (`packages/http-api`)

RESTful API endpoints:

```mermaid
graph LR
    subgraph "API Endpoints"
        subgraph "Health & Status"
            HEALTH[GET /health]
            STATS[GET /api/stats]
            ANALYTICS[GET /api/analytics]
        end
        
        subgraph "Account Management"
            LIST_ACC[GET /api/accounts]
            ADD_ACC[POST /api/accounts]
            DEL_ACC[DELETE /api/accounts/:id]
            PAUSE_ACC[POST /api/accounts/:id/pause]
            RESUME_ACC[POST /api/accounts/:id/resume]
            TIER_ACC[POST /api/accounts/:id/tier]
        end
        
        subgraph "Configuration"
            GET_CFG[GET /api/config]
            GET_STRAT[GET /api/config/strategy]
            SET_STRAT[POST /api/config/strategy]
            LIST_STRAT[GET /api/strategies]
        end
        
        subgraph "Monitoring"
            REQ_SUM[GET /api/requests]
            REQ_DET[GET /api/requests/detail]
            LOG_STREAM[GET /api/logs/stream]
            LOG_HIST[GET /api/logs/history]
        end
    end
```

### 7. Core Packages

#### Core DI (`packages/core-di`)

Dependency injection container for managing service instances:

```mermaid
graph TB
    subgraph "DI Container"
        CONT[Container]
        KEYS[Service Keys]
        
        subgraph "Registered Services"
            CFG[Config Service]
            LOG[Logger Service]
            DB[Database Service]
            PRICE[Pricing Logger]
        end
    end
    
    CONT -->|Register| CFG
    CONT -->|Register| LOG
    CONT -->|Register| DB
    CONT -->|Register| PRICE
    KEYS -->|Identify| CONT
```

**Features:**
- Service registration and resolution
- Singleton pattern for shared instances
- Type-safe service keys
- Lifecycle management

#### Core (`packages/core`)

Shared utilities and types:
- Strategy interfaces and base implementations
- Account availability checks
- Pricing calculations
- Lifecycle management (graceful shutdown)
- Strategy store interface

#### Config (`packages/config`)

Configuration management:
- Runtime configuration
- Strategy selection
- Port and session duration settings
- File-based persistence
- Change event notifications

#### Types (`packages/types`)

Shared TypeScript type definitions:
- API response types
- Strategy enums
- Logging interfaces
- Common data structures

### 8. CLI Commands Package (`packages/cli-commands`)

Command implementations for the CLI:

```mermaid
graph LR
    subgraph "Commands"
        ACC[Account Management]
        STATS[Statistics]
        HELP[Help System]
    end
    
    subgraph "Prompts"
        ADAPT[Prompt Adapter]
        STD[Standard Input]
    end
    
    subgraph "Utils"
        BROWSER[Browser Launcher]
    end
    
    ACC --> ADAPT
    ADAPT --> STD
    ACC --> BROWSER
```

### 9. TUI Core Package (`packages/tui-core`)

Terminal UI functionality:
- Account management screens
- Log viewing
- Request monitoring
- Statistics display
- Server status

### 10. Dashboard Package (`packages/dashboard-web`)

React-based monitoring dashboard:

```mermaid
graph TB
    subgraph "Dashboard Architecture"
        APP[App Component]
        
        subgraph "Tabs"
            OVER[Overview Tab]
            ACC[Accounts Tab]
            REQ[Requests Tab]
            LOGS[Logs Tab]
            ANAL[Analytics Tab]
            STATS[Stats Tab]
        end
        
        subgraph "Components"
            NAV[Navigation]
            THEME[Theme Toggle]
            CARDS[Metric Cards]
            TABLES[Data Tables]
            CHARTS[Charts]
        end
        
        subgraph "State Management"
            CTX[Theme Context]
            HOOKS[Custom Hooks]
            API_CLIENT[API Client]
        end
    end
    
    APP --> NAV
    APP --> TABS
    TABS --> OVER
    TABS --> ACC
    TABS --> REQ
    TABS --> LOGS
    TABS --> ANAL
    TABS --> STATS
    
    OVER --> CARDS
    ACC --> TABLES
    REQ --> TABLES
    ANAL --> CHARTS
    
    TABS --> API_CLIENT
    APP --> CTX
```

## Applications

### 1. Server App (`apps/server`)

The main HTTP server application that:
- Hosts the proxy endpoints
- Serves the web dashboard
- Provides REST API endpoints
- Manages WebSocket connections for real-time updates

### 2. CLI App (`apps/cli`)

Command-line interface for managing Claudeflare:
- Account management (add, remove, list)
- Statistics viewing
- Configuration updates
- Uses `packages/cli-commands` for implementation

### 3. TUI App (`apps/tui`)

Terminal User Interface built with Ink (React for CLI):
- Real-time monitoring dashboard in the terminal
- Interactive account management
- Log streaming
- Request monitoring
- Uses `packages/tui-core` for screens

### 4. Landing Page (`apps/lander`)

Static landing page for the project:
- Project overview
- Screenshots
- Getting started guide
- Built with vanilla HTML/CSS

## Component Interaction Patterns

### Request Flow Sequence

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Router
    participant Proxy
    participant LoadBalancer
    participant Database
    participant Provider
    participant Claude API
    
    Client->>Server: HTTP Request
    Server->>Router: Route Request
    
    alt API Route
        Router->>Database: Query Data
        Database-->>Router: Return Data
        Router-->>Client: JSON Response
    else Proxy Route
        Router->>Proxy: Forward to Proxy
        Proxy->>LoadBalancer: Get Account
        LoadBalancer->>Database: Get Available Accounts
        Database-->>LoadBalancer: Account List
        LoadBalancer-->>Proxy: Selected Account
        
        alt Token Expired
            Proxy->>Provider: Refresh Token
            Provider-->>Proxy: New Token
            Proxy->>Database: Update Token
        end
        
        Proxy->>Claude API: Forward Request
        Claude API-->>Proxy: Response
        
        Proxy->>Database: Log Request
        Proxy->>Database: Update Stats
        Proxy-->>Client: Proxy Response
    end
```

### Account Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created: Add Account
    Created --> Active: OAuth Success
    
    Active --> RateLimited: Hit Rate Limit
    Active --> Paused: Manual Pause
    Active --> Expired: Token Expired
    
    RateLimited --> Active: Reset Time Reached
    Paused --> Active: Manual Resume
    Expired --> Active: Token Refresh
    
    Active --> Removed: Delete Account
    Paused --> Removed: Delete Account
    Removed --> [*]
```

## Key Architectural Decisions

### 1. Modular Package Structure
- **Decision**: Organize code into focused packages with clear boundaries
- **Rationale**: Enables independent development, testing, and potential microservice migration
- **Trade-offs**: Some code duplication vs. tight coupling

### 2. SQLite for Persistence
- **Decision**: Use SQLite as the primary database
- **Rationale**: Zero-configuration, file-based, sufficient for expected load
- **Trade-offs**: Limited concurrent writes vs. operational simplicity

### 3. Bun Runtime
- **Decision**: Use Bun instead of Node.js
- **Rationale**: Better performance, built-in TypeScript, native SQLite support
- **Trade-offs**: Smaller ecosystem vs. performance gains

### 4. Strategy Pattern for Load Balancing
- **Decision**: Implement load balancing as pluggable strategies
- **Rationale**: Easy to add new algorithms, runtime switching
- **Trade-offs**: Additional abstraction vs. flexibility

### 5. Provider Abstraction
- **Decision**: Abstract AI providers behind a common interface
- **Rationale**: Future-proof for multiple AI services
- **Trade-offs**: Over-engineering for single provider vs. extensibility

### 6. Real-time Monitoring
- **Decision**: Include comprehensive logging and real-time dashboards
- **Rationale**: Critical for debugging rate limits and performance
- **Trade-offs**: Storage overhead vs. observability

## Technology Stack

### Runtime & Language
- **Bun**: High-performance JavaScript runtime
- **TypeScript**: Type-safe development
- **React**: Dashboard UI framework
- **Tailwind CSS**: Utility-first styling

### Data Storage
- **SQLite**: Primary database
- **File System**: Log storage

### Key Libraries
- **@tanstack/react-query**: Dashboard data fetching
- **@nivo/charts**: Analytics visualization
- **Ink**: Terminal UI framework
- **Commander**: CLI framework

### Development Tools
- **Biome**: Linting and formatting
- **Bun**: Monorepo management and build system
- **TypeScript**: Build system

## Security Considerations

1. **Token Storage**: OAuth tokens encrypted at rest
2. **API Authentication**: Currently relies on network security (localhost)
3. **Rate Limit Protection**: Automatic account rotation prevents service disruption
4. **Request Logging**: Sensitive data can be logged (configurable)

## Performance Characteristics

1. **Request Overhead**: ~5-10ms for load balancing decision
2. **Token Refresh**: Cached to prevent stampedes
3. **Database Queries**: Optimized with indexes on timestamp fields
4. **Memory Usage**: Scales with active connections and log retention

## Future Extensibility

The architecture supports:
1. Additional AI providers (OpenAI, Cohere, etc.)
2. Distributed deployment with external database
3. Webhook notifications for events
4. Advanced analytics and ML-based load prediction
5. Multi-region deployment for global distribution

## Deployment Architecture

### Current Single-Instance Deployment

```mermaid
graph TB
    subgraph "Local Machine"
        SERVER[Claudeflare Server<br/>Port 8080]
        DB[(SQLite DB)]
        LOGS[Log Files]
        CONFIG[Config Files]
    end
    
    subgraph "Clients"
        LOCAL[Local Apps]
        REMOTE[Remote Clients]
    end
    
    LOCAL -->|localhost:8080| SERVER
    REMOTE -->|http://host:8080| SERVER
    SERVER --> DB
    SERVER --> LOGS
    SERVER --> CONFIG
```

### Potential Distributed Architecture

```mermaid
graph TB
    subgraph "Load Balancer Tier"
        LB1[HAProxy/Nginx]
    end
    
    subgraph "Application Tier"
        APP1[Claudeflare Instance 1]
        APP2[Claudeflare Instance 2]
        APP3[Claudeflare Instance N]
    end
    
    subgraph "Data Tier"
        REDIS[(Redis Cache)]
        PG[(PostgreSQL)]
        S3[S3-Compatible<br/>Log Storage]
    end
    
    subgraph "Monitoring"
        PROM[Prometheus]
        GRAF[Grafana]
    end
    
    LB1 --> APP1
    LB1 --> APP2
    LB1 --> APP3
    
    APP1 --> REDIS
    APP2 --> REDIS
    APP3 --> REDIS
    
    APP1 --> PG
    APP2 --> PG
    APP3 --> PG
    
    APP1 --> S3
    APP2 --> S3
    APP3 --> S3
    
    APP1 --> PROM
    APP2 --> PROM
    APP3 --> PROM
    
    PROM --> GRAF
```

## Monorepo Benefits

1. **Code Sharing**: Packages can be easily shared between applications
2. **Atomic Changes**: Related changes across packages can be committed together
3. **Consistent Tooling**: Single set of build tools and configurations
4. **Simplified Dependencies**: Internal packages are linked, not published
5. **Better Refactoring**: Easy to move code between packages

## Development Workflow

1. **Local Development**: `bun dev` starts all necessary services
2. **Testing**: Per-package tests with shared test utilities
3. **Building**: Bun handles build orchestration
4. **Type Safety**: TypeScript project references ensure type consistency
5. **Linting/Formatting**: Biome provides consistent code style