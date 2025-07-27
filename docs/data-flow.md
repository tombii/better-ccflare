# Claudeflare Data Flow Documentation

## Overview

Claudeflare is a load balancer proxy for Claude API that distributes requests across multiple OAuth accounts to avoid rate limiting. This document details the complete data flow through the system, including request lifecycle, error handling, token refresh, and rate limit management.

## Table of Contents

1. [Overview of Request Lifecycle](#overview-of-request-lifecycle)
2. [Sequence Diagrams](#sequence-diagrams)
   - [Successful Request Flow](#successful-request-flow)
   - [Rate Limited Request Flow](#rate-limited-request-flow)
   - [Token Refresh Flow](#token-refresh-flow)
   - [Failed Request with Retry Flow](#failed-request-with-retry-flow)
3. [Error Handling Flows](#error-handling-flows)
4. [Request Retry Logic](#request-retry-logic)
5. [Database Update Patterns](#database-update-patterns)

## Overview of Request Lifecycle

The request lifecycle in Claudeflare follows these main stages:

1. **Request Reception**: Client sends request to Claudeflare server
2. **Route Determination**: Server checks if it's an API request, dashboard request, or proxy request
3. **Account Selection**: Load balancer strategy selects available accounts based on configured algorithm
4. **Token Validation**: System checks if account has valid access token, refreshes if needed
5. **Request Forwarding**: Proxy forwards request to Anthropic API with authentication
6. **Response Handling**: System processes response, extracts usage data, checks rate limits
7. **Data Persistence**: Updates database with request history, usage stats, and rate limit info
8. **Response Streaming**: Returns response to client, preserving streaming capabilities

## Sequence Diagrams

### Successful Request Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server as Claudeflare Server
    participant Router as API Router
    participant LoadBalancer as Load Balancer
    participant Proxy
    participant Provider as Anthropic Provider
    participant DB as Database
    participant Anthropic as Anthropic API

    Client->>Server: HTTP Request to /v1/*
    Server->>Router: Check API routes
    Router-->>Server: No match, continue
    Server->>Proxy: handleProxy(req, url, context)
    
    Note over Proxy: Generate request ID and metadata
    
    Proxy->>Provider: canHandle(path)?
    Provider-->>Proxy: true
    
    Proxy->>LoadBalancer: getOrderedAccounts(meta, strategy)
    LoadBalancer->>DB: getAllAccounts()
    DB-->>LoadBalancer: Account list
    LoadBalancer->>LoadBalancer: Filter by availability
    LoadBalancer->>LoadBalancer: Apply strategy algorithm
    LoadBalancer-->>Proxy: Ordered account list
    
    loop For each account until success
        Proxy->>Proxy: Check token validity
        alt Token expired
            Proxy->>Provider: refreshAccessTokenSafe()
            Provider->>Anthropic: POST /oauth/token
            Anthropic-->>Provider: New access token
            Provider->>DB: updateAccountTokens()
        end
        
        Proxy->>Provider: prepareHeaders(headers, accessToken)
        Proxy->>Provider: buildUrl(path, query)
        Proxy->>Anthropic: Forward request
        Anthropic-->>Proxy: Response (streaming or JSON)
        
        Proxy->>DB: updateAccountUsage(accountId)
        
        Proxy->>Provider: parseRateLimit(response)
        Provider-->>Proxy: Rate limit info
        
        alt Has rate limit metadata
            Proxy->>DB: updateAccountRateLimitMeta()
        end
        
        alt Response OK
            Proxy->>Provider: extractUsageInfo(response)
            Provider-->>Proxy: Usage data (tokens, model, cost)
            
            alt Has tier info
                Proxy->>Provider: extractTierInfo(response)
                Provider-->>Proxy: Account tier
                Proxy->>DB: updateAccountTier()
            end
            
            Proxy->>DB: saveRequest(success)
            Proxy->>DB: saveRequestPayload()
            
            Proxy->>Provider: processResponse(response)
            Proxy-->>Server: Processed response
            Server-->>Client: Stream response
        end
    end
```

### Rate Limited Request Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Proxy
    participant Provider
    participant DB
    participant Anthropic

    Client->>Server: HTTP Request
    Server->>Proxy: handleProxy()
    
    Proxy->>Proxy: Select account from strategy
    Proxy->>Proxy: Validate/refresh token
    Proxy->>Anthropic: Forward request
    
    alt Hard rate limit (429 or rate_limited status)
        Anthropic-->>Proxy: 429 Rate Limited
        Note over Anthropic: Headers: anthropic-ratelimit-unified-status: rate_limited<br/>anthropic-ratelimit-unified-reset: 1234567890
        
        Proxy->>Provider: parseRateLimit(response)
        Provider-->>Proxy: {isRateLimited: true, resetTime: 1234567890000}
        
        Proxy->>DB: markAccountRateLimited(accountId, resetTime)
        Note over DB: Set rate_limited_until = resetTime
        
        Proxy->>DB: saveRequestPayload(rateLimited: true)
        
        Proxy->>Proxy: Continue to next account
        
        alt No more accounts available
            Proxy->>DB: saveRequest(status: 503, error: "All accounts failed")
            Proxy-->>Client: 503 Service Unavailable
        else Another account available
            Proxy->>Proxy: Try next account
        end
    else Soft warning (allowed_warning)
        Anthropic-->>Proxy: 200 OK
        Note over Anthropic: Headers: anthropic-ratelimit-unified-status: allowed_warning<br/>anthropic-ratelimit-unified-remaining: 50
        
        Proxy->>Provider: parseRateLimit(response)
        Provider-->>Proxy: {isRateLimited: false, statusHeader: "allowed_warning", remaining: 50}
        
        Proxy->>DB: updateAccountRateLimitMeta()
        Note over DB: Update rate limit metadata only
        
        Proxy->>Provider: processResponse()
        Proxy-->>Client: 200 OK (continue normally)
    end
```

### Token Refresh Flow

```mermaid
sequenceDiagram
    participant Proxy
    participant RefreshMap as refreshInFlight Map
    participant Provider
    participant DB
    participant Anthropic

    Note over Proxy: Multiple requests may need token refresh
    
    Proxy->>Proxy: getValidAccessToken(account)
    
    alt Token expired or missing
        Proxy->>RefreshMap: Check if refresh in progress?
        
        alt No refresh in progress
            Proxy->>RefreshMap: Set refresh promise
            Proxy->>Provider: refreshToken(account, clientId)
            Provider->>Anthropic: POST /v1/oauth/token
            Note over Provider: Body: {grant_type: "refresh_token",<br/>refresh_token: account.refresh_token,<br/>client_id: clientId}
            
            alt Refresh successful
                Anthropic-->>Provider: {access_token: "new_token", expires_in: 3600}
                Provider->>DB: updateAccountTokens(id, token, expiresAt)
                Provider-->>Proxy: New access token
                Proxy->>RefreshMap: Delete promise
            else Refresh failed
                Anthropic-->>Provider: Error response
                Provider-->>Proxy: Throw error
                Proxy->>RefreshMap: Delete promise
                Proxy->>Proxy: Try next account
            end
        else Refresh already in progress
            Proxy->>RefreshMap: Get existing promise
            Note over Proxy: Wait for existing refresh to complete
            RefreshMap-->>Proxy: Resolved access token
        end
    else Token still valid
        Proxy-->>Proxy: Return existing token
    end
```

### Failed Request with Retry Flow

```mermaid
sequenceDiagram
    participant Client
    participant Server
    participant Proxy
    participant Provider
    participant DB
    participant Anthropic

    Client->>Server: HTTP Request
    Server->>Proxy: handleProxy()
    
    Proxy->>Proxy: Select account
    
    loop Retry up to runtime.retry.attempts times
        Note over Proxy: Retry attempt #1
        
        alt First attempt
            Proxy->>Anthropic: Forward request
        else Retry attempt
            Note over Proxy: Wait retry.delayMs * (backoff ^ attempt)
            Proxy->>Proxy: Sleep for backoff delay
            Proxy->>Anthropic: Retry request
        end
        
        alt Network error
            Anthropic--xProxy: Connection timeout/error
            Proxy->>DB: saveRequestPayload(error, retry count)
            
            alt More retries available
                Note over Proxy: Continue to next retry
            else Max retries reached
                Proxy->>Proxy: Log failure for account
                Proxy->>Proxy: Try next account
            end
        else Success
            Anthropic-->>Proxy: Successful response
            Proxy->>DB: saveRequest(success)
            Proxy-->>Client: Return response
            Note over Proxy: Exit retry loop
        end
    end
    
    alt All accounts and retries exhausted
        Proxy->>DB: saveRequest(status: 503, error: "All accounts failed")
        Proxy->>DB: saveRequestPayload(final failure)
        Proxy-->>Client: 503 Service Unavailable
    end
```

## Error Handling Flows

### Provider Cannot Handle Path

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant Provider

    Client->>Proxy: Request to unsupported path
    Proxy->>Provider: canHandle(path)?
    Provider-->>Proxy: false
    Proxy-->>Client: 400 Bad Request<br/>{"error": "Provider cannot handle this request path"}
```

### No Available Accounts (Fallback Mode)

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant LoadBalancer
    participant DB
    participant Anthropic

    Client->>Proxy: HTTP Request
    Proxy->>LoadBalancer: getOrderedAccounts()
    LoadBalancer->>DB: getAllAccounts()
    DB-->>LoadBalancer: Empty or all rate-limited
    LoadBalancer-->>Proxy: [] (empty array)
    
    Note over Proxy: Fallback to unauthenticated mode
    
    Proxy->>Anthropic: Forward without auth headers
    
    alt Success
        Anthropic-->>Proxy: Response
        Proxy->>DB: saveRequest(accountId: "no-account")
        Proxy-->>Client: Forward response
    else Failure
        Anthropic-->>Proxy: Error
        Proxy->>DB: saveRequest(error)
        Proxy-->>Client: 502 Bad Gateway
    end
```

## Request Retry Logic

The retry mechanism follows an exponential backoff strategy:

```mermaid
flowchart TD
    A[Start Request] --> B{Token Valid?}
    B -->|No| C[Refresh Token]
    B -->|Yes| D[Send Request]
    C --> D
    
    D --> E{Response OK?}
    E -->|Yes| F[Process Response]
    E -->|No| G{Rate Limited?}
    
    G -->|Yes| H[Mark Account Limited]
    G -->|No| I{Retries < Max?}
    
    H --> J[Try Next Account]
    I -->|Yes| K[Wait Backoff Delay]
    I -->|No| J
    
    K --> L[Increment Retry]
    L --> D
    
    J --> M{More Accounts?}
    M -->|Yes| B
    M -->|No| N[Return 503 Error]
    
    F --> O[Save Stats & Return]
```

### Retry Configuration

- **Initial delay**: `runtime.retry.delayMs` (default from config)
- **Backoff multiplier**: `runtime.retry.backoff`
- **Max attempts**: `runtime.retry.attempts`
- **Delay calculation**: `delayMs * (backoff ^ attemptNumber)`

## Database Update Patterns

### Request Lifecycle Updates

```mermaid
flowchart LR
    subgraph "Per Request Updates"
        A[Request Start] --> B[updateAccountUsage]
        B --> C{Response Type}
        C -->|Success| D[saveRequest<br/>success=true]
        C -->|Rate Limited| E[markAccountRateLimited<br/>saveRequest]
        C -->|Error| F[saveRequest<br/>with error]
        
        D --> G[saveRequestPayload]
        E --> G
        F --> G
        
        D --> H[updateAccountRateLimitMeta]
        E --> H
        
        D --> I[extractUsageInfo]
        I --> J[Update cost/tokens]
        
        D --> K[extractTierInfo]
        K --> L[updateAccountTier]
    end
```

### Account State Management

```mermaid
stateDiagram-v2
    [*] --> Active: Account Added
    Active --> TokenExpired: Token expires
    TokenExpired --> Active: Token refreshed
    Active --> RateLimited: Hit rate limit
    RateLimited --> Active: Reset time reached
    Active --> Paused: Manual pause
    Paused --> Active: Manual unpause
    
    note right of Active
        - Can receive requests
        - Token valid
        - Not rate limited
    end note
    
    note right of RateLimited
        - rate_limited_until set
        - Skipped by strategies
        - Auto-clears after reset
    end note
    
    note right of TokenExpired
        - Triggers refresh flow
        - Blocks until refreshed
    end note
```

### Session Management (Session Strategy)

```mermaid
flowchart TD
    A[Request Arrives] --> B{Active Session?}
    B -->|Yes| C{Session Expired?}
    B -->|No| D[Select New Account]
    
    C -->|No| E[Use Session Account]
    C -->|Yes| F[Reset Session]
    
    D --> G[Start New Session]
    F --> G
    
    G --> H[Set session_start = now]
    H --> I[Set session_request_count = 0]
    
    E --> J[Increment session_request_count]
    I --> J
    
    J --> K[Process Request]
```

### Database Tables Updated

1. **accounts** table:
   - `last_used`: Updated on every request
   - `request_count`: Incremented per request
   - `total_requests`: Lifetime counter
   - `rate_limited_until`: Set when rate limited
   - `access_token` & `expires_at`: Updated on token refresh
   - `account_tier`: Updated when detected from response
   - `session_start` & `session_request_count`: For session strategy
   - `rate_limit_status`, `rate_limit_reset`, `rate_limit_remaining`: Rate limit metadata

2. **requests** table:
   - One row per request with status, timing, and usage data
   - Links to account used (or "no-account" for fallback)
   - Stores error messages for failed requests

3. **request_payloads** table:
   - Stores full request/response bodies (base64 encoded)
   - Includes headers and metadata
   - Used for debugging and replay

### Update Transaction Flow

```mermaid
sequenceDiagram
    participant Request
    participant DB
    
    Note over Request,DB: During Request Processing
    
    Request->>DB: BEGIN (implicit)
    Request->>DB: updateAccountUsage()
    Note over DB: UPDATE accounts SET last_used, request_count++
    
    alt Rate Limited
        Request->>DB: markAccountRateLimited()
        Note over DB: UPDATE accounts SET rate_limited_until
    end
    
    Request->>DB: updateAccountRateLimitMeta()
    Note over DB: UPDATE accounts SET rate_limit_*
    
    Request->>DB: saveRequest()
    Note over DB: INSERT INTO requests
    
    Request->>DB: saveRequestPayload()
    Note over DB: INSERT INTO request_payloads
    
    alt Tier Changed
        Request->>DB: updateAccountTier()
        Note over DB: UPDATE accounts SET account_tier
    end
    
    Request->>DB: COMMIT (implicit)
```

## Summary

The Claudeflare data flow is designed to:

1. **Maximize availability** through multiple account rotation and retry logic
2. **Prevent stampedes** with singleton token refresh promises
3. **Track everything** for debugging and analytics
4. **Handle failures gracefully** with fallback modes and clear error reporting
5. **Respect rate limits** intelligently, distinguishing between hard limits and warnings
6. **Optimize performance** through streaming responses and efficient database updates

The system ensures reliable Claude API access while providing comprehensive monitoring and management capabilities through its dashboard and API endpoints.