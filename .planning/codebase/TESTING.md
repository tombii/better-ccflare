# Testing Patterns

**Analysis Date:** 2026-02-05

## Test Framework

**Runner:**
- Bun's built-in test runner
- Version: Bun >=1.2.8 (from `package.json`)
- Native support for `.test.ts` and `.spec.ts` files
- No additional test framework configuration needed

**Assertion Library:**
- Bun's native assertion library imported from `"bun:test"`
- Built-in: `describe`, `it`/`test`, `expect`, `beforeEach`, `beforeAll`, `afterEach`, `afterAll`

**Run Commands:**
```bash
bun test                          # Run all tests
bun test --watch                  # Watch mode for development
bun test --coverage               # Generate coverage report
bun run test:cli                  # Run only CLI tests (apps/cli/__tests__)
```

## Test File Organization

**Location:**
- **Co-located pattern:** Tests placed in `__tests__` subdirectory adjacent to source
- Example: `packages/security/src/__tests__/path-validator.test.ts` tests `packages/security/src/path-validator.ts`
- Alternative: Some tests use `.test.ts` suffix in same directory

**Naming:**
- Test files: `{component}.test.ts` or `{component}.spec.ts`
- Directory: `__tests__` subdirectory within package source
- Example: `path-validator.test.ts`, `session-strategy.test.ts`, `oauth.test.ts`

**Structure:**
```
packages/{package}/src/
├── component.ts
├── __tests__/
│   └── component.test.ts
└── index.ts
```

## Test Structure

**Suite organization:**
```typescript
import { describe, expect, it, beforeEach, afterAll } from "bun:test";

describe("Component Name", () => {
	// Optional: Setup before all tests
	let component: MyComponent;
	let mockDependency: MockType;

	beforeEach(() => {
		// Reset state before each test
		component = new MyComponent();
		mockDependency = new MockType();
	});

	afterAll(() => {
		// Cleanup after all tests in suite
		// Example: delete temporary directories
	});

	describe("Feature/Method Name", () => {
		it("should do X when Y condition is met", () => {
			// Arrange
			const input = testData;

			// Act
			const result = component.method(input);

			// Assert
			expect(result).toBe(expectedValue);
		});
	});
});
```

**Patterns observed:**
- Nested `describe` blocks for organizing related tests
- `beforeEach` for test-local setup (preferred over `beforeAll` when state isolation needed)
- `beforeAll` for expensive setup shared across suite
- `afterAll` for resource cleanup (file system, temp directories)
- Comment pattern: "should [behavior] when [condition]" for test names

## Mocking

**Framework:** Manual mocking using class implementation
- No external mocking library (vitest, jest, sinon)
- Mock objects implement interfaces directly

**Patterns observed:**
```typescript
// Mock class implementing interface
class MockStrategyStore implements StrategyStore {
	resetCalls: Array<{ accountId: string; timestamp: number }> = [];
	resumeCalls: string[] = [];

	resetAccountSession(accountId: string, timestamp: number): void {
		this.resetCalls.push({ accountId, timestamp });
	}

	resumeAccount(accountId: string): void {
		this.resumeCalls.push(accountId);
	}

	// Helper methods for assertions
	getResetCall(accountId: string): { accountId: string; timestamp: number } | undefined {
		return this.resetCalls.find((call) => call.accountId === accountId);
	}

	hasResumeCall(accountId: string): boolean {
		return this.resumeCalls.includes(accountId);
	}

	clear(): void {
		this.resetCalls = [];
		this.resumeCalls = [];
	}
}

// Usage in tests
const mockStore = new MockStrategyStore();
strategy.initialize(mockStore);
// ... run test ...
expect(mockStore.getResetCall(accountId)).toBeDefined();
```

**Mocking global functions:**
```typescript
// Mock fetch for OAuth token tests
const originalFetch = global.fetch;
global.fetch = async () => ({
	ok: true,
	json: async () => ({
		refresh_token: "test-refresh-token",
		access_token: "test-access-token",
		expires_in: 3600,
	}),
}) as any;

try {
	const result = await oauthProvider.exchangeCode(...);
	// assertions
} finally {
	global.fetch = originalFetch; // Always restore
}
```

**What to Mock:**
- External HTTP calls (via global.fetch)
- Dependencies injected into classes (strategy store, database operations)
- Time-dependent operations (use explicit timestamps, not `Date.now()` in comparisons)

**What NOT to Mock:**
- File system operations for legitimate test scenarios
- Core library functions
- Actual utility functions being tested
- Cryptographic operations (use real implementations, not mocks)

## Fixtures and Factories

**Test data:**
```typescript
// Inline object creation for simple cases
const account: Account = {
	id: "test-account-1",
	name: "test-account-1",
	provider: "anthropic",
	api_key: null,
	refresh_token: "test",
	access_token: "test",
	expires_at: Date.now() + 3600000,
	request_count: 0,
	total_requests: 0,
	last_used: null,
	created_at: Date.now(),
	rate_limited_until: null,
	session_start: Date.now() - 2 * 60 * 60 * 1000,
	session_request_count: 5,
	paused: false,
	rate_limit_reset: Date.now() - 2000,
	rate_limit_status: null,
	rate_limit_remaining: null,
	priority: 0,
	auto_fallback_enabled: false,
	auto_refresh_enabled: false,
	custom_endpoint: null,
	model_mappings: null,
};

// Helper for test setup (in beforeEach or local scope)
const createTestAccount = (overrides: Partial<Account>): Account => ({
	id: "test-account-1",
	name: "test-account-1",
	provider: "anthropic",
	// ... default values ...
	...overrides,
});
```

**Location:**
- Inline in test files (no separate fixtures directory)
- Reusable factories defined at top of test file after imports
- Per-test overrides for small variations

## Coverage

**Requirements:** Not enforced
- No minimum coverage threshold configured
- Coverage reports available via `bun test --coverage`
- Test-driven: Write tests that matter for security/complexity, not for percentage

**View Coverage:**
```bash
bun test --coverage
# Outputs coverage summary to console
```

## Test Types

**Unit Tests:**
- Scope: Individual functions or classes
- Location: `__tests__` directories in package source
- Examples: `path-validator.test.ts`, `utils.test.ts`
- Approach: Direct function calls with controlled inputs, no external dependencies

**Integration Tests:**
- Scope: Classes with dependencies, strategy selection, complex workflows
- Location: Same `__tests__` directories (distinguished by naming)
- Examples: `session-strategy.test.ts`, `oauth.test.ts`
- Approach: Instantiate real classes, inject mock dependencies, verify interactions

**E2E Tests:**
- Status: Not detected in codebase
- Alternative: Integration tests serve similar purpose for closed-box testing

## Common Patterns

**Async Testing:**
```typescript
// Using async/await in test functions
it("should handle token exchange without concatenated state", async () => {
	const pkce = await generatePKCE();
	const result = await oauthProvider.exchangeCode("code", pkce.verifier, config);
	expect(result).toBeDefined();
});

// Returning promise from test
it("should validate paths", () => {
	return validatePath("/tmp/test").then(result => {
		expect(result.isValid).toBe(true);
	});
});
```

**Error Testing:**
```typescript
// Testing thrown errors
it("should throw error on traversal attempt", () => {
	expect(() => {
		validatePathOrThrow("../../etc/passwd", { description: "test" });
	}).toThrow("Directory traversal detected");
});

// Testing error type and message
try {
	validatePathOrThrow("../../etc/passwd", { description: "test" });
	expect(true).toBe(false); // Should not reach
} catch (error) {
	expect(error instanceof Error).toBe(true);
	expect((error as Error).message).toContain("Directory traversal");
}
```

**Boundary Condition Testing:**
```typescript
// Testing edge cases explicitly
it("should not reset session when rate_limit_reset equals current time (boundary condition)", () => {
	const now = Date.now();
	const account: Account = {
		// ... account setup ...
		rate_limit_reset: now, // Equal to current time (boundary)
	};

	const result = strategy.select([account], meta);
	expect(result[0]).toBe(account);

	const resetCall = mockStore.getResetCall(account.id);
	expect(resetCall).toBeUndefined(); // Not reset at boundary
});

// Testing "just past" boundary
it("should reset session when rate_limit_reset is just less than now - 1000", () => {
	const now = Date.now();
	const account: Account = {
		// ... account setup ...
		rate_limit_reset: now - 1001, // Just past threshold
	};

	const result = strategy.select([account], meta);
	const resetCall = mockStore.getResetCall(account.id);
	expect(resetCall).toBeDefined(); // Reset past boundary
});
```

**File System Testing:**
```typescript
// Setup temp directories before tests
beforeAll(() => {
	mkdirSync(SAFE_DIR, { recursive: true });
	writeFileSync(join(SAFE_DIR, "test.txt"), "safe content");
});

// Cleanup after tests
afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

// Test file operations
it("should validate paths within /tmp", () => {
	const result = validatePath(join(TEST_DIR, "safe", "test.txt"), {
		description: "test path",
	});
	expect(result.isValid).toBe(true);
});
```

**Type Testing with @ts-expect-error:**
```typescript
// Test invalid input handling (intentional type violations)
it("should reject null input", () => {
	// @ts-expect-error - Testing invalid input
	const result = validatePath(null, { description: "null input" });

	expect(result.isValid).toBe(false);
	expect(result.reason).toContain("Invalid input");
	expect(result.reason).toContain("null");
});
```

**Provider-Specific Testing:**
```typescript
// Testing different provider behaviors
it("should work normally for non-Anthropic providers", () => {
	const account: Account = {
		// ... account setup ...
		provider: "zai", // Non-anthropic provider
		rate_limit_reset: null, // No rate limit tracking
	};

	const result = strategy.select([account], meta);

	// Verify session was NOT reset for non-Anthropic
	const resetCall = mockStore.getResetCall(account.id);
	expect(resetCall).toBeUndefined();
});
```

**Multi-account Testing:**
```typescript
// Testing with multiple accounts and priority ordering
it("should handle multiple accounts with different rate limit reset scenarios", () => {
	const account1 = { id: "acc-1", priority: 0, /* ... */ };
	const account2 = { id: "acc-2", priority: 1, /* ... */ };
	const account3 = { id: "acc-3", priority: 2, /* ... */ };

	const result = strategy.select([account2, account3, account1], meta);

	// Higher priority (lower number) selected first
	expect(result[0]).toBe(account1);
	expect(result).toHaveLength(3);

	// Verify only account1 was modified
	const resetCall1 = mockStore.getResetCall(account1.id);
	const resetCall2 = mockStore.getResetCall(account2.id);
	expect(resetCall1).toBeDefined();
	expect(resetCall2).toBeUndefined();
});
```

---

*Testing analysis: 2026-02-05*
