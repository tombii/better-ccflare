# Coding Conventions

**Analysis Date:** 2026-02-05

## Naming Patterns

**Files:**
- Source files: lowercase with hyphens for multi-word names (e.g., `path-validator.ts`, `session-strategy.ts`)
- Test files: `{name}.test.ts` or `{name}.spec.ts` suffix (e.g., `path-validator.test.ts`)
- Index files: `index.ts` for barrel exports and entry points
- Type definition files: typically co-located in same file or separate `types.ts`

**Functions:**
- camelCase for all function names
- Private methods prefixed with underscore: `_methodName` or marked with `private` keyword
- Factory functions often named with `create` or `generate` prefix (e.g., `generatePKCE`)
- Async functions follow same naming: camelCase (e.g., `exchangeCode`, `validatePath`)

**Variables:**
- camelCase for all variables and constants within functions
- SCREAMING_SNAKE_CASE for true constants (e.g., `MAX_DECODE_ITERATIONS`, `DEFAULT_CACHE_SIZE`)
- Private class properties prefixed with underscore (e.g., `private _store: StrategyStore`)
- Cached values explicitly named: `cachedDefaultAllowedPaths`

**Types and Interfaces:**
- PascalCase for all type names and interfaces (e.g., `RequestOptions`, `PathValidationResult`, `SessionStrategy`)
- Interfaces often prefixed with `I` is NOT used; pure PascalCase preferred (e.g., `SecurityConfig` not `ISecurityConfig`)
- Error types: PascalCase with `Error` suffix (e.g., `HttpError`, `ValidationError`, `OAuthError`)
- Type aliases for discriminated unions and branded types follow same PascalCase rule

## Code Style

**Formatting:**
- Tool: Biome 2.3.7 with automatic formatting
- Indentation: **tabs** (configured in `biome.json`)
- Line width: No strict limit enforced, natural wrapping preferred
- Quote style: **double quotes** for strings (configured as `quoteStyle: "double"`)
- Semicolons: Always included (Biome default)

**Run commands:**
```bash
bun run format      # Format all code with Biome
bun run lint        # Lint and auto-fix with Biome
```

**Linting:**
- Tool: Biome 2.3.7 (integrated linter)
- Rules: `recommended` preset enabled in `biome.json`
- Auto-fix unsafe rules: Yes (`--unsafe` flag in lint script)
- VCS integration: Enabled (respects `.gitignore` and uses git context)

## Import Organization

**Order:**
1. Node.js built-in modules first (e.g., `import { existsSync } from "node:fs"`)
2. Third-party packages (e.g., `import type { Config } from "@better-ccflare/config"`)
3. Internal packages (e.g., `import { Logger } from "@better-ccflare/logger"`)
4. Relative imports from same package (e.g., `import { validatePath } from "../path-validator"`)

**Path Aliases:**
- `@better-ccflare/*` → `packages/*/src` - Primary workspace packages
- `@better-ccflare/server` → `apps/server/src/server.ts` - Server entry point
- `@better-ccflare/dashboard-web/dist/*` → `packages/dashboard-web/dist/*` - Dashboard assets

**Barrel files:**
- Pattern: `packages/{package}/src/index.ts` re-exports public API
- Example: `packages/errors/src/index.ts` exports error types and utilities
- Used for: Organizing exports from multiple related files into single import

**Organize imports:**
- Biome `organizeImports` action enabled in assist
- Automatic removal of unused imports
- Automatic grouping and sorting of imports

## Error Handling

**Patterns:**
- Custom error types extend `Error` class with property-based details
- `HttpError` class signature: `HttpError(status: number, message: string, details?: unknown)`
- Error type discriminators: Use `instanceof` checks (e.g., `if (error instanceof HttpError)`)
- Factory functions for common HTTP errors (e.g., `BadRequest(message, details)`, `Unauthorized(message, details)`)

**Error creation:**
```typescript
// Use factory functions
throw BadRequest("Invalid input", { field: "email" });

// Or direct instantiation
throw new HttpError(401, "Authentication failed", { reason: "token_expired" });
```

**Error handling patterns:**
- Wrap fetch calls with try/catch and clear timeouts in finally
- Check error.name for specific error types: `error.name === "AbortError"` for timeouts
- Never swallow errors silently; always log or re-throw with context
- Use error type checkers: `isAuthError()`, `isRateLimitError()`, `isNetworkError()`

## Logging

**Framework:** `Logger` class from `@better-ccflare/logger`

**Usage pattern:**
```typescript
import { Logger } from "@better-ccflare/logger";

const log = new Logger("ComponentName");

log.info("Operation completed", { details });
log.error("Failed to process", { error });
log.warn("Rate limit approaching");
```

**When to log:**
- Session state changes (start, reset, expiration)
- Account availability changes
- Rate limit events
- OAuth flows and token exchanges
- Configuration mismatches
- Fallback account selection

**What NOT to log:**
- API keys or tokens (use redacted values only)
- User authentication credentials
- Full request/response bodies for sensitive operations

## Comments

**When to comment:**
- Complex algorithms or security-sensitive logic (e.g., path traversal detection)
- Non-obvious business logic (e.g., rate limit window reset conditions)
- Integration details with external systems (e.g., OAuth flows)
- Workarounds and their reasons (e.g., clock skew buffer of 1 second)

**JSDoc/TSDoc:**
- Required for: Public APIs, interfaces, complex functions
- Optional for: Private methods, simple utilities
- Format: `/** description */` for single-line, `/** multi-line */` for longer

**Example patterns:**
```typescript
/**
 * Validates a file path against directory traversal attacks
 * @param path The path to validate
 * @param options Validation configuration
 * @returns Validation result with resolved path or rejection reason
 */
function validatePath(path: string, options: SecurityConfig): PathValidationResult

/** Cache NODE_ENV check for performance */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// 1 second buffer for clock skew protection
const rateLimitWindowReset = account.rate_limit_reset < now - 1000;
```

## Function Design

**Size:**
- Prefer functions under 50 lines
- Complex logic extracted into private helper methods
- Single responsibility per function

**Parameters:**
- Options/config objects preferred over multiple parameters
- Use destructuring in function signatures: `{ timeout = 30000, retries = 0 }`
- Type options interfaces (e.g., `ClientOptions`, `RequestOptions`)

**Return values:**
- Explicit return types required (TypeScript strict mode)
- Nullable returns: Use `| null` or `| undefined` explicitly
- Objects with discriminated unions for results (e.g., `{ isValid: boolean; reason?: string }`)
- Async functions always return `Promise<T>`

**Example:**
```typescript
async request<T = unknown>(
	url: string,
	options: RequestOptions = {},
): Promise<T> {
	const {
		timeout = this.options.timeout,
		retries = this.options.retries,
		...fetchOptions
	} = options;
	// implementation
}
```

## Module Design

**Exports:**
- Named exports preferred: `export function validatePath(...)`
- Default exports: Only for class instances or configuration objects
- Re-exports in barrel files: `export { ErrorType } from "./errors"`

**Class design:**
- Private properties: `private log = new Logger("ClassName")`
- Constructor for dependency injection: `constructor(options: ClientOptions = {})`
- Public methods for external API
- Private helper methods for internal complexity

**Example structure:**
```typescript
export class SessionStrategy implements LoadBalancingStrategy {
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionStrategy");

	constructor(sessionDurationMs: number = DEFAULT_DURATION) {
		this.sessionDurationMs = sessionDurationMs;
	}

	initialize(store: StrategyStore): void { /* ... */ }

	select(accounts: Account[], meta: RequestMeta): Account[] { /* ... */ }

	private resetSessionIfExpired(account: Account): void { /* ... */ }
}
```

## Type Strictness

**Configuration:**
- `"strict": true` in `tsconfig.json`
- `"noEmit": true` (type checking only, Bun handles execution)
- `"forceConsistentCasingInFileNames": true`
- `"allowImportingTsExtensions": true` (for direct TS imports in workspace)

**Common patterns:**
- Explicit type parameters: `as unknown as DatabaseOperations` for mocking
- Type assertions for test helpers: `(error as Error).message`
- Nullable checks: `if (value != null)` for both null and undefined
- Discriminated unions: `{ isValid: true; resolvedPath: string } | { isValid: false; reason: string }`

## Workspace-Specific Rules

**Package organization:**
- `packages/*` - Reusable libraries and shared utilities
- `apps/*` - Executable applications (CLI, server, web)
- Each package has own `tsconfig.json` extending root config
- Each package has own `package.json` with dependencies

**Monorepo imports:**
- Always use `@better-ccflare/*` path aliases, never relative paths to other packages
- Example: `import { Logger } from "@better-ccflare/logger"` not `import { Logger } from "../../../logger/src"`

---

*Convention analysis: 2026-02-05*
