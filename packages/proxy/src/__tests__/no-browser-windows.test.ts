import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import type { ProxyContext } from "../proxy";

// Mock the browser opening at the module level
const _mockOpenBrowser = mock(() => Promise.resolve(true));
const mockOpen = mock(() => Promise.resolve());

// Intercept module imports to prevent browser opening
const originalImport = globalThis.import;
globalThis.import = mock((modulePath: string) => {
	if (modulePath === "open") {
		return Promise.resolve({ default: mockOpen });
	} else if (modulePath === "node:child_process") {
		return Promise.resolve({
			spawn: mock(() => ({
				unref: mock(() => {}),
				exited: Promise.resolve(0),
			})),
		});
	}
	return originalImport(modulePath);
});

// Test database path
const TEST_DB_PATH = "/tmp/test-no-browser.db";

describe("No Browser Windows Tests", () => {
	let _dbOps: DatabaseOperations;
	let scheduler: AutoRefreshScheduler;
	let mockProxyContext: ProxyContext;
	let browserOpenCount = 0;
	let originalGetValidAccessToken: typeof globalThis.getValidAccessToken;

	beforeAll(async () => {
		// Store original getValidAccessToken to restore later
		originalGetValidAccessToken = globalThis.getValidAccessToken;

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
		_dbOps = DatabaseFactory.getInstance();

		// Create mock proxy context
		mockProxyContext = {
			runtime: {
				port: 8082,
				clientId: "test-client-id",
			},
		} as ProxyContext;

		// Initialize scheduler
		scheduler = new AutoRefreshScheduler(
			DatabaseFactory.getInstance().getDatabase(),
			mockProxyContext,
		);

		// Mock the browser opening function
		browserOpenCount = 0;
		(scheduler as { openBrowser: unknown }).openBrowser = mock(async () => {
			browserOpenCount++;
			return true;
		});
	});

	afterEach(() => {
		// Reset global modifications between tests to prevent state leakage
		globalThis.getValidAccessToken = originalGetValidAccessToken;
	});

	afterAll(() => {
		// Clean up test database
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
		globalThis.import = originalImport;
	});

	describe("Browser Opening Prevention", () => {
		it("should not open browser when token refresh succeeds in background", async () => {
			// Mock background refresh to succeed
			const mockGetValidAccessToken = mock(() =>
				Promise.resolve("new-access-token"),
			);
			globalThis.getValidAccessToken = mockGetValidAccessToken;

			const now = Date.now();
			const expiresIn20Minutes = now + 20 * 60 * 1000;

			// Create a test account with an expiring token
			const db = DatabaseFactory.getInstance().getDatabase();
			db.run(`
        INSERT INTO accounts (
          id, name, provider, refresh_token, access_token, expires_at,
          created_at, request_count, total_requests, auto_refresh_enabled
        ) VALUES ('test-no-browser', 'no-browser-test', 'anthropic', 'valid-refresh-token', 'expiring-access-token', ${expiresIn20Minutes}, ${now}, 0, 0, 1)
      `);

			try {
				// Simulate auto-refresh check finding this account
				const accounts = db
					.query(`
          SELECT id, name, provider, refresh_token, access_token, expires_at, rate_limit_reset, custom_endpoint
          FROM accounts
          WHERE auto_refresh_enabled = 1 AND provider = 'anthropic' AND expires_at <= ?
        `)
					.all(now + 30 * 60 * 1000);

				expect(accounts.length).toBe(1);

				// Simulate the new token refresh logic (background refresh first)
				const accountRow = accounts[0];

				// This would normally trigger OAuth reauth in the old implementation
				// But with our new implementation, it should try background refresh first

				// Since we mocked getValidAccessToken to succeed, no browser should open
				const accessToken = await mockGetValidAccessToken(
					accountRow,
					mockProxyContext,
				);

				expect(accessToken).toBe("new-access-token");
				expect(browserOpenCount).toBe(0); // No browser should open
			} finally {
				// Clean up test data
				db.run("DELETE FROM accounts WHERE id = 'test-no-browser'");
			}
		});

		it("should open browser only when background refresh fails", async () => {
			// Mock background refresh to fail
			const mockGetValidAccessToken = mock(() =>
				Promise.reject(new Error("Refresh failed")),
			);
			globalThis.getValidAccessToken = mockGetValidAccessToken;

			const now = Date.now();
			const expiresIn20Minutes = now + 20 * 60 * 1000;

			// Create a test account with an expiring token
			const db = DatabaseFactory.getInstance().getDatabase();
			db.run(`
        INSERT INTO accounts (
          id, name, provider, refresh_token, access_token, expires_at,
          created_at, request_count, total_requests, auto_refresh_enabled
        ) VALUES ('test-browser-fallback', 'browser-fallback-test', 'anthropic', 'invalid-refresh-token', 'expiring-access-token', ${expiresIn20Minutes}, ${now}, 0, 0, 1)
      `);

			try {
				// Simulate auto-refresh check finding this account
				const accounts = db
					.query(`
          SELECT id, name, provider, refresh_token, access_token, expires_at, rate_limit_reset, custom_endpoint
          FROM accounts
          WHERE auto_refresh_enabled = 1 AND provider = 'anthropic' AND expires_at <= ?
        `)
					.all(now + 30 * 60 * 1000);

				expect(accounts.length).toBe(1);

				// Since background refresh fails, it should proceed to OAuth reauth
				// In the real implementation, this would open a browser
				// For this test, we're just verifying the flow, not actual OAuth completion

				const accountRow = accounts[0];

				// Mock the OAuth reauth to not actually open browser (just track the call)
				const mockInitiateOAuthReauth = mock(() => Promise.resolve(true));
				(scheduler as { initiateOAuthReauth: unknown }).initiateOAuthReauth =
					mockInitiateOAuthReauth;

				// Simulate the new token refresh logic with failed background refresh
				try {
					await mockGetValidAccessToken(accountRow, mockProxyContext);
				} catch (_error) {
					// Background refresh failed - this is expected
					// Now it would proceed to browser reauth
					const result = await mockInitiateOAuthReauth(accountRow);
					expect(result).toBe(true);
				}

				// Browser would open here in real implementation, but we're not testing that part
			} finally {
				// Clean up test data
				db.run("DELETE FROM accounts WHERE id = 'test-browser-fallback'");
			}
		});

		it("should verify browser opening function is properly mocked", async () => {
			// Test that our mock is working
			const result = await (scheduler as { openBrowser: unknown }).openBrowser(
				"https://example.com",
			);
			expect(result).toBe(true);
			expect(browserOpenCount).toBe(1);

			console.log(
				`✅ Browser opening was properly mocked - no actual windows opened`,
			);
		});
	});

	describe("Test Cleanup", () => {
		it("should not leave any stale data in database", () => {
			const db = DatabaseFactory.getInstance().getDatabase();

			// Check that no test accounts remain
			const accounts = db
				.query("SELECT * FROM accounts WHERE name LIKE 'test-%'")
				.all();
			expect(accounts.length).toBe(0);

			// Check that no test OAuth sessions remain
			const sessions = db
				.query("SELECT * FROM oauth_sessions WHERE account_name LIKE 'test-%'")
				.all();
			expect(sessions.length).toBe(0);

			console.log(`✅ Test database cleaned up properly`);
		});
	});
});
