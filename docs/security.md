# Security Documentation

This document outlines the security considerations, practices, and recommendations for the Claudeflare load balancer system.

## Table of Contents

1. [Security Overview](#security-overview)
2. [Threat Model](#threat-model)
3. [OAuth Token Security](#oauth-token-security)
4. [Rate Limit Handling](#rate-limit-handling)
5. [Network Security](#network-security)
6. [Data Privacy](#data-privacy)
7. [Access Control](#access-control)
8. [Security Best Practices](#security-best-practices)
9. [Vulnerability Disclosure](#vulnerability-disclosure)
10. [Common Security Pitfalls](#common-security-pitfalls)

## Security Overview

Claudeflare is a load balancer proxy that manages multiple OAuth accounts to distribute requests to the Claude API. The system handles sensitive authentication tokens and request/response data, requiring careful security considerations.

### Key Security Components

- **OAuth Token Management**: Handles refresh tokens, access tokens, and token rotation
- **Request Proxying**: Forwards API requests with authentication headers
- **Data Storage**: SQLite database storing account credentials and request history
- **Local Network Binding**: Server binds to localhost by default
- **Request/Response Logging**: Full payload storage for debugging and analytics

## Threat Model

### Assets to Protect

1. **OAuth Tokens**: Refresh tokens and access tokens for Claude API access
2. **Request Data**: User prompts and API request payloads
3. **Response Data**: Claude's responses containing potentially sensitive information
4. **Account Metadata**: Usage statistics, rate limit information, and tier data

### Threat Actors

1. **External Attackers**: Attempting to access the proxy from outside the local network
2. **Local Malicious Software**: Processes on the same machine trying to access stored tokens
3. **Supply Chain Attacks**: Compromised dependencies or packages
4. **Insider Threats**: Users with legitimate access misusing the system

### Attack Vectors

1. **Network Exposure**: Proxy accidentally exposed to public internet
2. **Database Access**: Direct access to SQLite database file
3. **Token Theft**: Extraction of OAuth tokens from storage or memory
4. **Request Interception**: MITM attacks on API requests
5. **Log File Access**: Unauthorized access to request/response logs

## OAuth Token Security

### Current Implementation

#### Token Storage
```typescript
// packages/database/src/migrations.ts
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,  // Stored in plaintext
    access_token TEXT,             // Stored in plaintext
    expires_at INTEGER
)
```

**Security Concern**: Tokens are currently stored in plaintext in the SQLite database.

#### Token Refresh Pattern
```typescript
// packages/proxy/src/proxy.ts
async function refreshAccessTokenSafe(account: Account, ctx: ProxyContext): Promise<string> {
    // Prevents token refresh stampede with in-flight tracking
    if (!ctx.refreshInFlight.has(account.id)) {
        const refreshPromise = ctx.provider.refreshToken(account, ctx.runtime.clientId)
            .then((result: TokenRefreshResult) => {
                ctx.dbOps.updateAccountTokens(account.id, result.accessToken, result.expiresAt);
                return result.accessToken;
            })
            .finally(() => {
                ctx.refreshInFlight.delete(account.id);
            });
        ctx.refreshInFlight.set(account.id, refreshPromise);
    }
    return ctx.refreshInFlight.get(account.id)!;
}
```

**Security Strength**: Implements stampede prevention to avoid multiple concurrent refresh attempts.

#### Token Scope Limitations
- OAuth tokens are obtained through the official Anthropic OAuth flow
- Tokens are scoped to the specific client ID
- No mechanism currently exists to limit token permissions further

### Future Improvements

#### 1. Token Encryption at Rest
```typescript
// Proposed implementation
interface EncryptedToken {
    iv: string;
    encryptedData: string;
    authTag: string;
}

async function encryptToken(token: string, key: Buffer): Promise<EncryptedToken> {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return {
        iv: iv.toString('base64'),
        encryptedData: encrypted.toString('base64'),
        authTag: authTag.toString('base64')
    };
}
```

#### 2. Key Management
- Use environment variable for encryption key: `CLAUDEFLARE_ENCRYPTION_KEY`
- Implement key derivation from master password
- Consider integration with OS keychain/credential store

#### 3. Token Rotation
- Implement automatic token rotation before expiry
- Add configurable rotation intervals
- Log rotation events for audit trail

## Rate Limit Handling

### Current Implementation

The system implements sophisticated rate limit detection and handling:

```typescript
// packages/providers/src/providers/anthropic/provider.ts
parseRateLimit(response: Response): RateLimitInfo {
    const statusHeader = response.headers.get("anthropic-ratelimit-unified-status");
    const resetHeader = response.headers.get("anthropic-ratelimit-unified-reset");
    
    // Distinguishes between hard limits (blocking) and soft warnings
    const isRateLimited = HARD_LIMIT_STATUSES.has(statusHeader || "") || response.status === 429;
    
    return {
        isRateLimited,
        resetTime: resetHeader ? Number(resetHeader) * 1000 : undefined,
        statusHeader: statusHeader || undefined,
        remaining: remainingHeader ? Number(remainingHeader) : undefined
    };
}
```

### Protection Mechanisms

1. **Account Quarantine**: Rate-limited accounts are automatically excluded from rotation
2. **Reset Time Tracking**: Precise tracking of when accounts become available again
3. **Soft vs Hard Limits**: Differentiates between warnings and actual blocks
4. **Failover Strategy**: Automatically tries next available account on rate limit

## Network Security

### Current Configuration

#### Default Binding
```typescript
// packages/config/src/index.ts
getRuntime(): RuntimeConfig {
    const defaults: RuntimeConfig = {
        port: 8080,  // Binds to all interfaces by default
        // ...
    };
}
```

**Security Concern**: The server binds to port 8080 on all interfaces, potentially exposing it to the network.

### Recommended Configuration

#### 1. Local-Only Binding
**Note**: Currently, the server binds to all interfaces (0.0.0.0) by default. To restrict to localhost only:

```bash
# Use environment variable (requires code modification)
HOST=127.0.0.1 PORT=8080 bun start

# Or use a reverse proxy/firewall to restrict access
```

**TODO**: Implement HOST environment variable support in server configuration.

#### 2. Reverse Proxy Setup
```nginx
# Nginx configuration example
server {
    listen 443 ssl http2;
    server_name claudeflare.internal;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Security headers
        add_header X-Content-Type-Options nosniff;
        add_header X-Frame-Options DENY;
        add_header X-XSS-Protection "1; mode=block";
    }
}
```

#### 3. TLS/HTTPS Setup
- Use TLS termination at reverse proxy level
- Ensure strong cipher suites (TLS 1.2+)
- Implement HSTS headers
- Consider mutual TLS for additional security

## Data Privacy

### Request/Response Logging

#### Current Implementation
```typescript
// packages/proxy/src/proxy.ts
const payload = {
    request: {
        headers: Object.fromEntries(req.headers.entries()),
        body: requestBody ? Buffer.from(requestBody).toString("base64") : null
    },
    response: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody ? Buffer.from(responseBody).toString("base64") : null
    }
};
ctx.dbOps.saveRequestPayload(requestMeta.id, payload);
```

**Privacy Concern**: Full request/response bodies are stored, potentially containing sensitive information.

### Storage Security Considerations

1. **Base64 Encoding**: Request/response bodies are Base64 encoded but not encrypted
2. **Database File Access**: SQLite database file can be read by any process with file system access
3. **No Data Sanitization**: Sensitive patterns (API keys, passwords, PII) are not redacted
4. **Unlimited Retention**: No automatic cleanup of old request payloads

### PII Considerations

1. **User Prompts**: May contain personal information, proprietary code, or confidential data
2. **API Keys**: While not stored in payloads, they appear in logs
3. **Response Content**: Claude's responses may echo back sensitive information

### Log Retention

#### Current State
- No automatic log rotation or cleanup
- Request payloads stored indefinitely in SQLite database
- File logs written to disk without rotation

#### Recommended Practices

1. **Implement Log Rotation**
```typescript
// Proposed log rotation configuration
interface LogRotationConfig {
    maxAge: number;        // Days to retain logs
    maxSize: number;       // Max size per log file in MB
    compress: boolean;     // Compress old logs
    deleteOnRotate: boolean; // Delete after rotation
}
```

2. **Data Minimization**
- Add option to disable request/response body logging
- Implement selective logging based on endpoint
- Add data redaction for sensitive patterns

3. **Cleanup Commands**
```bash
# Add to CLI
bun cli cleanup --older-than 30d
bun cli cleanup --type requests --force
```

## Access Control

### Current State
- No authentication required to access the proxy
- Dashboard accessible without authentication
- API endpoints unprotected
- No CORS headers configured (allows any origin)
- No rate limiting on API endpoints

### Future Authentication Implementation

#### 1. API Key Authentication
```typescript
// Proposed middleware
async function authenticateRequest(req: Request): Promise<boolean> {
    const apiKey = req.headers.get('X-API-Key');
    if (!apiKey) return false;
    
    const hashedKey = await crypto.subtle.digest(
        'SHA-256', 
        new TextEncoder().encode(apiKey)
    );
    
    return timingSafeEqual(hashedKey, storedHashedKey);
}
```

#### 2. Dashboard Authentication
- Implement session-based authentication
- Add rate limiting on login attempts
- Consider OAuth integration for SSO

#### 3. Role-Based Access Control
```typescript
enum Permission {
    VIEW_DASHBOARD = 'dashboard.view',
    MANAGE_ACCOUNTS = 'accounts.manage',
    VIEW_LOGS = 'logs.view',
    MAKE_REQUESTS = 'api.request'
}

interface User {
    id: string;
    username: string;
    permissions: Permission[];
}
```

## Security Best Practices

### Deployment Checklist

- [ ] **Network Configuration**
  - [ ] Bind server to localhost only
  - [ ] Configure firewall rules
  - [ ] Set up reverse proxy with TLS
  - [ ] Disable unnecessary network services

- [ ] **Token Security**
  - [ ] Store encryption key securely (environment variable or secret manager)
  - [ ] Implement token encryption at rest
  - [ ] Regular token rotation schedule
  - [ ] Monitor for token leaks in logs

- [ ] **Access Control**
  - [ ] Implement authentication for all endpoints
  - [ ] Use strong, unique API keys
  - [ ] Enable audit logging
  - [ ] Regular access reviews

- [ ] **Data Protection**
  - [ ] Configure log rotation
  - [ ] Implement data retention policies
  - [ ] Regular database backups
  - [ ] Encrypt sensitive backups

- [ ] **Monitoring**
  - [ ] Set up alerts for suspicious activity
  - [ ] Monitor rate limit patterns
  - [ ] Track authentication failures
  - [ ] Regular security audits

### Development Practices

1. **Dependency Management**
   - Regular dependency updates: `bun update`
   - Security audit: `bun audit`
   - Lock file verification
   - Supply chain security checks

2. **Code Security**
   - Input validation on all endpoints
   - Output encoding for web responses
   - Parameterized database queries (already implemented)
   - Secure random number generation for IDs

3. **Error Handling**
   - Avoid exposing stack traces in production
   - Generic error messages to users
   - Detailed error logging internally
   - Rate limit error responses

## Vulnerability Disclosure

### Reporting Process

1. **Discovery**: If you discover a security vulnerability, please report it responsibly
2. **Contact**: Email security concerns to the project maintainers
3. **Information to Include**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fixes (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Fix Development**: Based on severity
- **Disclosure**: Coordinated with reporter

### Severity Levels

1. **Critical**: Token exposure, RCE, authentication bypass
2. **High**: Data exposure, privilege escalation
3. **Medium**: Information disclosure, DoS
4. **Low**: Minor information leaks

## Common Security Pitfalls

### 1. Exposed Development Instance
**Risk**: Running Claudeflare with default settings exposes it to the network
**Mitigation**: Always bind to localhost in development

### 2. Token in Logs
**Risk**: OAuth tokens appearing in debug logs
**Mitigation**: Implement log sanitization, never log full tokens

### 3. Shared Database Access
**Risk**: Multiple users accessing the same SQLite database
**Mitigation**: Implement proper file permissions, consider client/server database

### 4. Unencrypted Backups
**Risk**: Database backups containing plaintext tokens
**Mitigation**: Encrypt backups, secure backup storage

### 5. Insufficient Rate Limiting
**Risk**: Single client overwhelming the proxy
**Mitigation**: Implement per-client rate limiting

### 6. CORS Misconfiguration
**Risk**: Dashboard API accessible from unauthorized origins
**Mitigation**: Implement CORS headers:
```typescript
// Recommended CORS configuration
const corsHeaders = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGINS || 'http://localhost:8080',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block'
};
```

### 7. Dependency Vulnerabilities
**Risk**: Known vulnerabilities in dependencies
**Mitigation**: Regular updates, security scanning

### 8. Weak Randomness
**Risk**: Predictable IDs or tokens
**Mitigation**: Use crypto.randomUUID() and crypto.getRandomValues()

## Security Roadmap

### Phase 1: Token Encryption (Priority: High)
- Implement AES-256-GCM encryption for stored tokens
- Add key management system
- Migration tool for existing tokens

### Phase 2: Authentication (Priority: High)
- API key authentication for proxy endpoints
- Dashboard authentication system
- Audit logging for all access

### Phase 3: Network Hardening (Priority: Medium)
- TLS support in proxy server
- Certificate pinning for API calls
- IP allowlisting capability

### Phase 4: Advanced Security (Priority: Low)
- Hardware security module (HSM) integration
- Multi-factor authentication
- Anomaly detection system

## Environment Variables

### Security-Related Environment Variables

```bash
# Logging and Debugging
LOG_LEVEL=INFO                  # Set to ERROR in production
LOG_FORMAT=json                 # Use json for structured logging
CLAUDEFLARE_DEBUG=0            # Set to 1 only for debugging

# Configuration
CLAUDEFLARE_CONFIG_PATH=/path/to/config.json  # Custom config location
CLIENT_ID=your-client-id       # OAuth client ID

# Server Configuration
PORT=8080                      # Server port
LB_STRATEGY=session           # Load balancing strategy

# Retry Configuration
RETRY_ATTEMPTS=3              # Number of retry attempts
RETRY_DELAY_MS=1000          # Initial retry delay
RETRY_BACKOFF=2              # Backoff multiplier
SESSION_DURATION_MS=18000000 # Session duration (5 hours)
```

### Security Considerations for Environment Variables

1. **Never commit `.env` files** containing sensitive values
2. **Use secret management** tools in production (e.g., HashiCorp Vault, AWS Secrets Manager)
3. **Restrict file permissions** on environment files: `chmod 600 .env`
4. **Audit environment access** in containerized deployments

## Conclusion

Security is an ongoing process. This documentation should be reviewed and updated regularly as the system evolves and new threats emerge. All contributors should familiarize themselves with these security considerations and follow the best practices outlined above.

For security-related questions or concerns, please refer to the vulnerability disclosure process or contact the project maintainers directly.