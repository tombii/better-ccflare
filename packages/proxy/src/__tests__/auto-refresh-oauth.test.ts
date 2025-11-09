import { afterAll, beforeAll, describe, expect, it, mock, beforeEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { Config } from "@better-ccflare/config";
import { DatabaseOperations, DatabaseFactory } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import type { ProxyContext } from "../proxy";

// Test database path
const TEST_DB_PATH = "/tmp/test-oauth-reauth.db";

// Mock the logger to avoid actual log output during tests
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};

// Mock console methods to avoid noise during tests
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

describe("AutoRefreshScheduler - OAuth Reauthentication", () => {
  let db: Database;
  let dbOps: DatabaseOperations;
  let scheduler: AutoRefreshScheduler;
  let mockProxyContext: ProxyContext;

  beforeAll(async () => {
    // Mock console methods
    console.log = mock(() => {});
    console.warn = mock(() => {});
    console.error = mock(() => {});

    // Clean up any existing test database
    try {
      if (existsSync(TEST_DB_PATH)) {
        unlinkSync(TEST_DB_PATH);
      }
    } catch (error) {
      console.warn("Failed to clean up existing test database:", error);
    }

    // Initialize test database
    DatabaseFactory.initialize(TEST_DB_PATH);
    dbOps = DatabaseFactory.getInstance();
    db = dbOps.getDatabase();

    // Create mock proxy context
    mockProxyContext = {
      runtime: {
        port: 8080,
        clientId: "test-client-id",
      },
    } as ProxyContext;

    // Initialize scheduler
    scheduler = new AutoRefreshScheduler(db, mockProxyContext);
  });

  afterAll(() => {
    // Restore console methods
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;

    // Clean up test database
    try {
      if (existsSync(TEST_DB_PATH)) {
        unlinkSync(TEST_DB_PATH);
      }
    } catch (error) {
      console.warn("Failed to clean up test database:", error);
    }
    DatabaseFactory.reset();
  });

  describe("Token expiration detection", () => {
    it("should identify expired tokens", () => {
      const now = Date.now();
      const expiredAccount = {
        id: "test-expired",
        name: "expired-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: now - 10000, // Expired 10 seconds ago
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      // Access private method for testing
      const isExpired = (scheduler as any).isTokenExpired(expiredAccount, now);
      expect(isExpired).toBe(true);
    });

    it("should identify tokens expiring within buffer period", () => {
      const now = Date.now();
      const expiringSoonAccount = {
        id: "test-expiring",
        name: "expiring-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: now + 4 * 60 * 1000, // Expires in 4 minutes (less than 5-minute buffer)
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      const isExpired = (scheduler as any).isTokenExpired(expiringSoonAccount, now);
      expect(isExpired).toBe(true);
    });

    it("should identify valid tokens", () => {
      const now = Date.now();
      const validAccount = {
        id: "test-valid",
        name: "valid-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: now + 10 * 60 * 1000, // Expires in 10 minutes
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      const isExpired = (scheduler as any).isTokenExpired(validAccount, now);
      expect(isExpired).toBe(false);
    });

    it("should handle accounts without expiration time", () => {
      const noExpiryAccount = {
        id: "test-no-expiry",
        name: "no-expiry-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: null,
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      const now = Date.now();
      const isExpired = (scheduler as any).isTokenExpired(noExpiryAccount, now);
      expect(isExpired).toBe(false);
    });
  });

  describe("OAuth session management", () => {
    it("should create OAuth session for reauthentication", async () => {
      const accountRow = {
        id: "test-reauth",
        name: "reauth-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: Date.now() - 10000, // Expired
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      // Mock all the external dependencies properly
      const mockOpen = mock(() => Promise.resolve());
      const mockGeneratePKCE = mock(() => ({
        verifier: "test-verifier",
        challenge: "test-challenge",
        method: "S256",
      }));
      const mockOAuthProvider = {
        getOAuthConfig: mock(() => ({
          authorizeUrl: "https://claude.ai/oauth/authorize",
          tokenUrl: "https://console.anthropic.com/v1/oauth/token",
          clientId: "test-client-id",
          scopes: ["org:create_api_key", "user:profile", "user:inference"],
          redirectUri: "http://localhost:8080/oauth/callback",
          mode: "claude-oauth",
        })),
        generateAuthUrl: mock(() => "https://claude.ai/login?returnTo=oauth"),
      };
      const mockConfig = mock(() => ({ runtime: { clientId: "test-client-id" } }));
      const mockDbOps = {
        createOAuthSession: mock(() => {}),
        getOAuthSession: mock(() => null),
      };
      const mockOAuthFlow = {
        complete: mock(() => Promise.resolve({
          id: "test-reauth-id",
          name: "reauth-account",
          provider: "anthropic",
          authType: "oauth" as const,
        }))
      };
      const mockCreateOAuthFlow = mock(() => Promise.resolve(mockOAuthFlow));

      const originalImport = globalThis.import;
      globalThis.import = mock((modulePath: string) => {
        if (modulePath === "open") {
          return Promise.resolve({ default: mockOpen });
        } else if (modulePath === "@better-ccflare/config") {
          return Promise.resolve({ Config: mockConfig });
        } else if (modulePath === "@better-ccflare/database") {
          return Promise.resolve({ DatabaseOperations: mock(() => mockDbOps) });
        } else if (modulePath === "@better-ccflare/oauth-flow") {
          return Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow });
        } else if (modulePath === "@better-ccflare/providers") {
          return Promise.resolve({
            generatePKCE: mockGeneratePKCE,
            getOAuthProvider: () => mockOAuthProvider,
          });
        }
        return Promise.resolve({});
      });

      try {
        // Access private method for testing
        const result = await (scheduler as any).initiateOAuthReauth(accountRow);
        expect(result).toBe(true);

        // Verify OAuth session was created in the real database
        const sessions = db.query("SELECT * FROM oauth_sessions WHERE account_name = ?").all("reauth-account");
        expect(sessions.length).toBe(1);
        expect(sessions[0].account_name).toBe("reauth-account");
        expect(sessions[0].mode).toBe("claude-oauth");
      } finally {
        // Restore mocks
        globalThis.import = originalImport;
      }
    });

    it("should handle browser opening failures gracefully", async () => {
      const accountRow = {
        id: "test-fail-browser",
        name: "fail-browser-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: Date.now() - 10000,
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      // Mock the open package to fail
      const mockOpen = mock(() => Promise.reject(new Error("Browser not available")));
      const mockImportOpen = mock(() => Promise.resolve({ default: mockOpen }));

      // Mock child_process spawn to also fail
      const mockSpawn = mock(() => {
        throw new Error("Spawn failed");
      });
      const mockImportSpawn = mock(() => Promise.resolve({ spawn: mockSpawn }));

      // Mock other dependencies
      const mockGeneratePKCE = mock(() => ({
        verifier: "test-verifier",
        challenge: "test-challenge",
        method: "S256",
      }));

      const mockOAuthProvider = {
        getOAuthConfig: mock(() => ({
          authorizeUrl: "https://claude.ai/oauth/authorize",
          tokenUrl: "https://console.anthropic.com/v1/oauth/token",
          clientId: "test-client-id",
          scopes: ["org:create_api_key", "user:profile", "user:inference"],
          redirectUri: "http://localhost:8080/oauth/callback",
          mode: "claude-oauth",
        })),
        generateAuthUrl: mock(() => "https://claude.ai/login?returnTo=oauth"),
      };

      const mockImportOAuth = mock(() => Promise.resolve({ getOAuthProvider: () => mockOAuthProvider }));

      const originalImportFunction = globalThis.import;
      // Mock import to return different modules based on the request
      globalThis.import = mock((modulePath: string) => {
        if (modulePath === "open") {
          return mockImportOpen();
        } else if (modulePath === "node:child_process") {
          return mockImportSpawn();
        } else {
          return mockImportOAuth();
        }
      });

      try {
        // Should still succeed even if browser fails to open
        const result = await (scheduler as any).initiateOAuthReauth(accountRow);
        expect(result).toBe(true);

        // Session should still be created
        const sessions = db.query("SELECT * FROM oauth_sessions WHERE account_name = ?").all("fail-browser-account");
        expect(sessions.length).toBe(1);
      } finally {
        // Restore mocks
        globalThis.import = originalImportFunction;
      }
    });

    it("should use Windows PowerShell on Windows platform", async () => {
      // Mock Windows platform
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true
      });

      const accountRow = {
        id: "test-windows",
        name: "windows-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: Date.now() - 10000,
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      // Mock the open package to fail (so it falls back to platform-specific)
      const mockOpen = mock(() => Promise.reject(new Error("Open package not available")));
      const mockSpawn = mock(() => {
        const mockProcess = {
          unref: mock(() => {}),
        };
        return mockProcess;
      });

      // Mock the global import function properly
      const originalImportFunction = globalThis.import;
      globalThis.import = mock((modulePath: string) => {
        if (modulePath === "open") {
          return Promise.resolve({ default: mockOpen });
        } else if (modulePath === "node:child_process") {
          return Promise.resolve({ spawn: mockSpawn });
        } else if (modulePath === "@better-ccflare/config") {
          return Promise.resolve({ Config: mock(() => ({ runtime: { clientId: "test-client-id" } })) });
        } else if (modulePath === "@better-ccflare/database") {
          return Promise.resolve({ DatabaseOperations: mock(() => ({ createOAuthSession: mock() })) });
        } else if (modulePath === "@better-ccflare/oauth-flow") {
          return Promise.resolve({
            createOAuthFlow: mock(() => ({
              complete: mock(() => Promise.resolve({
                id: "test-windows-id",
                name: "windows-account",
                provider: "anthropic",
                authType: "oauth" as const,
              }))
            }))
          });
        } else if (modulePath === "@better-ccflare/providers") {
          const mockGeneratePKCE = mock(() => ({
            verifier: "test-verifier",
            challenge: "test-challenge",
            method: "S256",
          }));
          const mockOAuthProvider = {
            getOAuthConfig: mock(() => ({
              authorizeUrl: "https://claude.ai/oauth/authorize",
              tokenUrl: "https://console.anthropic.com/v1/oauth/token",
              clientId: "test-client-id",
              scopes: ["org:create_api_key", "user:profile", "user:inference"],
              redirectUri: "http://localhost:8080/oauth/callback",
              mode: "claude-oauth",
            })),
            generateAuthUrl: mock(() => "https://claude.ai/login?returnTo=oauth"),
          };
          return Promise.resolve({
            generatePKCE: mockGeneratePKCE,
            getOAuthProvider: () => mockOAuthProvider,
          });
        }
        return Promise.resolve({});
      });

      try {
        await (scheduler as any).initiateOAuthReauth(accountRow);

        // Verify Windows-specific spawn was called
        expect(mockSpawn).toHaveBeenCalledWith(
          "powershell.exe",
          ["-NoProfile", "-Command", "Start-Process", "'https://claude.ai/login?returnTo=oauth'"],
          {
            detached: true,
            stdio: "ignore",
          }
        );
      } finally {
        // Restore platform and imports
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          writable: true
        });
        globalThis.import = originalImportFunction;
      }
    });
  });

  describe("Window refresh logic", () => {
    it("should identify accounts needing window refresh", () => {
      const now = Date.now();
      const accountNeedingRefresh = {
        id: "test-refresh",
        name: "refresh-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: now + 10 * 60 * 1000, // Valid token
        rate_limit_reset: now - 10000, // Reset time has passed
        custom_endpoint: null,
      };

      // Mock the last refresh tracking
      (scheduler as any).lastRefreshResetTime.set("test-refresh", now - 60000); // Last refresh 1 minute ago

      const shouldRefresh = (scheduler as any).shouldRefreshWindow(accountNeedingRefresh, now);
      expect(shouldRefresh).toBe(true);
    });

    it("should skip accounts with current reset times", () => {
      const now = Date.now();
      const futureTime = now + 10 * 60 * 1000;
      const accountNotNeedingRefresh = {
        id: "test-no-refresh",
        name: "no-refresh-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: now + 10 * 60 * 1000,
        rate_limit_reset: futureTime, // Reset time in future
        custom_endpoint: null,
      };

      // Mock recent refresh with a time that's newer than the account's reset time but still in the past
      // This simulates that we already refreshed for this window
      (scheduler as any).lastRefreshResetTime.set("test-no-refresh", futureTime - 1000);

      const shouldRefresh = (scheduler as any).shouldRefreshWindow(accountNotNeedingRefresh, now);
      expect(shouldRefresh).toBe(false);
    });

    it("should handle stale reset times", () => {
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const accountWithStaleReset = {
        id: "test-stale",
        name: "stale-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: now + 10 * 60 * 1000,
        rate_limit_reset: oneDayAgo - 10000, // More than 24 hours old
        custom_endpoint: null,
      };

      const shouldRefresh = (scheduler as any).shouldRefreshWindow(accountWithStaleReset, now);
      expect(shouldRefresh).toBe(true);
    });
  });

  describe("Account selection logic", () => {
    beforeEach(() => {
      // Clean up tracking maps before each test
      (scheduler as any).lastRefreshResetTime.clear();
      (scheduler as any).consecutiveFailures.clear();
    });

    it("should separate accounts by refresh type", async () => {
      const now = Date.now();

      // Insert test accounts
      db.run(`
        INSERT INTO accounts (
          id, name, provider, refresh_token, access_token, expires_at,
          created_at, request_count, total_requests, auto_refresh_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        "expired-account",
        "expired-test",
        "anthropic",
        "refresh-token",
        "access-token",
        now - 10000, // Expired
        now,
        0, 0, 1 // auto_refresh_enabled = true
      ).run();

      db.run(`
        INSERT INTO accounts (
          id, name, provider, refresh_token, access_token, expires_at,
          rate_limit_reset, created_at, request_count, total_requests, auto_refresh_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        "window-account",
        "window-test",
        "anthropic",
        "refresh-token",
        "access-token",
        now + 10 * 60 * 1000, // Valid token
        now - 10000, // Reset time passed
        now,
        0, 0, 1 // auto_refresh_enabled = true
      ).run();

      // Mock the dummy message sending to avoid actual network calls
      const mockSendDummyMessage = mock(() => Promise.resolve(true));
      (scheduler as any).sendDummyMessage = mockSendDummyMessage;

      // Mock OAuth reauthentication
      const mockInitiateOAuthReauth = mock(() => Promise.resolve(true));
      (scheduler as any).initiateOAuthReauth = mockInitiateOAuthReauth;

      // Run the check
      await (scheduler as any).checkAndRefresh();

      // Verify both methods were called
      expect(mockSendDummyMessage).toHaveBeenCalled();
      expect(mockInitiateOAuthReauth).toHaveBeenCalled();

      // Clean up
      db.run("DELETE FROM accounts WHERE id IN ('expired-account', 'window-account')");
    });

    it("should skip accounts with auto-refresh disabled", () => {
      const now = Date.now();

      // Insert account with auto-refresh disabled
      db.run(`
        INSERT INTO accounts (
          id, name, provider, refresh_token, access_token, expires_at,
          created_at, request_count, total_requests, auto_refresh_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        "disabled-account",
        "disabled-test",
        "anthropic",
        "refresh-token",
        "access-token",
        now - 10000, // Expired token
        now,
        0, 0, 0 // auto_refresh_enabled = false
      ).run();

      // Mock methods to track calls
      const mockSendDummyMessage = mock(() => Promise.resolve(true));
      const mockInitiateOAuthReauth = mock(() => Promise.resolve(true));
      (scheduler as any).sendDummyMessage = mockSendDummyMessage;
      (scheduler as any).initiateOAuthReauth = mockInitiateOAuthReauth;

      // Run check - should not call any methods since auto-refresh is disabled
      return (scheduler as any).checkAndRefresh().then(() => {
        expect(mockSendDummyMessage).not.toHaveBeenCalled();
        expect(mockInitiateOAuthReauth).not.toHaveBeenCalled();

        // Clean up
        db.run("DELETE FROM accounts WHERE id = 'disabled-account'");
      });
    });
  });

  describe("Failure tracking", () => {
    it("should track consecutive failures", async () => {
      const accountRow = {
        id: "test-failures",
        name: "failure-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: Date.now() - 10000,
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      // Mock dependencies to fail consistently
      const mockImport = mock(() => Promise.reject(new Error("Always fails")));
      const originalImport = globalThis.import;
      globalThis.import = mockImport;

      try {
        // Simulate multiple failures by calling the real method with mocked failures
        for (let i = 0; i < 3; i++) {
          try {
            await (scheduler as any).initiateOAuthReauth(accountRow);
          } catch {
            // Expected to fail
          }
        }

        const failureCount = (scheduler as any).consecutiveFailures.get("test-failures");
        expect(failureCount).toBe(3);
      } finally {
        globalThis.import = originalImport;
      }
    });

    it("should reset failure count on success", async () => {
      const accountRow = {
        id: "test-success",
        name: "success-account",
        provider: "anthropic",
        refresh_token: "refresh-token",
        access_token: "access-token",
        expires_at: Date.now() - 10000,
        rate_limit_reset: null,
        custom_endpoint: null,
      };

      // Set initial failure count
      (scheduler as any).consecutiveFailures.set("test-success", 2);

      // Mock dependencies to succeed
      const mockOpen = mock(() => Promise.resolve());
      const mockImport = mock(() => Promise.resolve({
        createOAuthFlow: () => Promise.resolve({
          complete: () => Promise.resolve({
            id: "test-success-id",
            name: "success-account",
            provider: "anthropic",
            authType: "oauth" as const,
          })
        }),
        generatePKCE: () => ({ verifier: "test", challenge: "test", method: "S256" }),
        getOAuthProvider: () => ({
          getOAuthConfig: () => ({ clientId: "test" }),
          generateAuthUrl: () => "test-url"
        })
      }));
      const originalImport = globalThis.import;
      globalThis.import = mockImport;

      try {
        await (scheduler as any).initiateOAuthReauth(accountRow);

        // Failure count should be reset
        const failureCount = (scheduler as any).consecutiveFailures.get("test-success");
        expect(failureCount).toBeUndefined();
      } finally {
        globalThis.import = originalImport;
      }
    });
  });
});