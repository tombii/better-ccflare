import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockedFunction,
	vi,
} from "bun:test";
import type { ProxyContext } from "@better-ccflare/types";
import { AutoRefreshScheduler } from "../src/auto-refresh-scheduler";

// Create the mock logger instance at the module level so we can access it
const mockLoggerInstance = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
};

// Mock the Logger to capture log messages - this affects the static logger in the class
vi.mock("@better-ccflare/logger", () => ({
	Logger: vi.fn(() => mockLoggerInstance),
}));

// Mock the specific function to avoid complex OAuth logic in tests
vi.mock("../src/handlers/token-manager", () => ({
	getValidAccessToken: vi.fn().mockResolvedValue("mocked-access-token"),
}));

describe("AutoRefreshScheduler - Error Logging and Failure Tracking", () => {
	let db: Database;
	let scheduler: AutoRefreshScheduler;
	let mockProxyContext: MockedFunction<ProxyContext>;
	let mockLogger: any;
	let originalFetch: typeof global.fetch;

	beforeEach(() => {
		// Store original fetch
		originalFetch = global.fetch;

		db = new Database(":memory:");

		// Create the accounts table with necessary columns
		db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT DEFAULT 'anthropic',
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expires_at INTEGER,
        rate_limit_reset INTEGER,
        rate_limit_status TEXT,
        rate_limit_remaining INTEGER,
        rate_limited_until INTEGER,
        auto_refresh_enabled INTEGER DEFAULT 1,
        custom_endpoint TEXT
      )
    `);

		mockProxyContext = {
			strategy: {} as any, // Mock strategy
			dbOps: {} as any, // Mock dbOps
			runtime: {
				port: 8080,
			},
			provider: {} as any, // Mock provider
			refreshInFlight: new Map<string, Promise<string>>(), // Required for token manager
			asyncWriter: {} as any, // Mock asyncWriter
			usageWorker: {} as any, // Mock usageWorker
		} as any;

		// Create a new instance of the scheduler
		scheduler = new AutoRefreshScheduler(db, mockProxyContext);

		// Use the shared mock logger instance
		mockLogger = mockLoggerInstance;
	});

	afterEach(() => {
		// Clear only the mock calls, not all mocks (to preserve our logger mock setup)
		(mockLogger.info as MockedFunction<any>).mockClear();
		(mockLogger.warn as MockedFunction<any>).mockClear();
		(mockLogger.error as MockedFunction<any>).mockClear();
		(mockLogger.debug as MockedFunction<any>).mockClear();

		// Restore original fetch
		global.fetch = originalFetch;

		db.close();
		if (scheduler) {
			scheduler.stop();
		}
	});

	it("should track consecutive failures for accounts", async () => {
		// Insert an account that will be eligible for refresh (past rate_limit_reset)
		const pastTime = Date.now() - 1000; // 1 second ago
		db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, rate_limit_reset, auto_refresh_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"test-account-id-1",
			"test-account",
			"anthropic",
			"test-token",
			pastTime,
			1,
		);

		// Mock the fetch function to simulate failures - ensure it always fails
		const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
		global.fetch = fetchMock as any;

		// Call checkAndRefresh to trigger the failure tracking
		await (scheduler as any).checkAndRefresh();

		// Check that the fetch was called (meaning the account was selected for refresh)
		expect(fetchMock).toHaveBeenCalled();

		// Debug: Print all error and warn calls to see what was actually logged
		console.log(
			"Error calls:",
			(mockLogger.error as MockedFunction<any>).mock.calls,
		);
		console.log(
			"Warn calls:",
			(mockLogger.warn as MockedFunction<any>).mock.calls,
		);
		console.log(
			"Info calls:",
			(mockLogger.info as MockedFunction<any>).mock.calls,
		);
		console.log(
			"Debug calls:",
			(mockLogger.debug as MockedFunction<any>).mock.calls,
		);

		// Check that the failure was tracked (this is internal state, so we'll check logs)
		// When fetch rejects, the error is caught in the inner try/catch and the error message
		// is logged as "Failed to send auto-refresh message to [account] with any model: [error]"
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"Failed to send auto-refresh message to test-account with any model:",
			),
		);
	});

	it("should log authentication errors specifically", async () => {
		// Insert an account that will have auth failure (past rate_limit_reset to trigger refresh)
		const pastTime = Date.now() - 1000; // 1 second ago
		db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, rate_limit_reset, auto_refresh_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"auth-fail-account-2",
			"auth-fail-account",
			"anthropic",
			"invalid-token",
			pastTime,
			1,
		);

		// Mock fetch to return 401 to trigger auth error handling
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: vi.fn().mockResolvedValue("Authentication failed"),
		});
		global.fetch = fetchMock as any;

		// Call checkAndRefresh to trigger the auth error handling
		await (scheduler as any).checkAndRefresh();

		// Check that the fetch was called (meaning the account was selected for refresh)
		expect(fetchMock).toHaveBeenCalled();

		// Check that authentication error was logged
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"Authentication failed for account auth-fail-account",
			),
		);
	});

	it("should increment consecutive failure counter on auth errors", async () => {
		// Insert an account (past rate_limit_reset to trigger refresh)
		const pastTime = Date.now() - 1000; // 1 second ago
		db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, rate_limit_reset, auto_refresh_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"fail-account-3",
			"fail-account",
			"anthropic",
			"bad-token",
			pastTime,
			1,
		);

		// Mock fetch to throw an error to trigger failure counter
		const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
		global.fetch = fetchMock as any;

		// Call checkAndRefresh multiple times to test failure counting
		for (let i = 0; i < 3; i++) {
			await (scheduler as any).checkAndRefresh();
		}

		// Check that the fetch was called 3 times (meaning the account was selected for refresh each time)
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// Check that warnings about consecutive failures are logged
		const warnCalls = (mockLogger.warn as MockedFunction<any>).mock.calls;
		const failureWarningCalls = warnCalls.filter(
			(call) =>
				call[0].includes("has failed") &&
				call[0].includes("consecutive auto-refresh attempts"),
		);

		expect(failureWarningCalls).toHaveLength(3); // One for each failed attempt
	});

	it("should log special message when failure threshold is reached", async () => {
		// Insert an account (past rate_limit_reset to trigger refresh)
		const pastTime = Date.now() - 1000; // 1 second ago
		db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, rate_limit_reset, auto_refresh_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"threshold-account-4",
			"threshold-account",
			"anthropic",
			"failing-token",
			pastTime,
			1,
		);

		// Mock fetch to throw an error to trigger failure threshold
		const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
		global.fetch = fetchMock as any;

		// Call checkAndRefresh enough times to reach the failure threshold
		// The FAILURE_THRESHOLD is 5, so we need at least 5 calls
		for (let i = 0; i < 5; i++) {
			await (scheduler as any).checkAndRefresh();
		}

		// Check that the fetch was called 5 times (meaning the account was selected for refresh each time)
		expect(fetchMock).toHaveBeenCalledTimes(5);

		// Check that the special threshold message was logged
		const errorCalls = (mockLogger.error as MockedFunction<any>).mock.calls;
		const thresholdMessageCalls = errorCalls.filter(
			(call) =>
				call[0].includes("has failed 5 consecutive auto-refresh attempts") &&
				call[0].includes("needs re-authentication"),
		);

		expect(thresholdMessageCalls).toHaveLength(1);
	});

	it("should reset consecutive failure counter on successful refresh", async () => {
		// Insert an account (past rate_limit_reset to trigger refresh)
		const pastTime = Date.now() - 1000; // 1 second ago
		db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, rate_limit_reset, auto_refresh_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"success-account-5",
			"success-account",
			"anthropic",
			"valid-token",
			pastTime,
			1,
		);

		// Mock fetch to return success after a few failures
		let callCount = 0;
		const fetchMock = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount <= 2) {
				// First 2 calls fail
				return Promise.reject(new Error("Network error"));
			} else {
				// Subsequent calls succeed - but we need to make sure the API call works
				return Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					text: vi
						.fn()
						.mockResolvedValue(
							'{"id": "test", "content": [{"type": "text", "text": "response"}]}',
						),
					headers: {
						get: vi.fn().mockReturnValue("200"),
					},
				});
			}
		});
		global.fetch = fetchMock as any;

		// Call checkAndRefresh multiple times: 2 failures, then success
		for (let i = 0; i < 3; i++) {
			await (scheduler as any).checkAndRefresh();
		}

		// Check that the fetch was called 3 times (meaning the account was selected for refresh each time)
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// Check that failure counter was reset after success
		// After success, the consecutive failure counter should be cleared
		// We can verify this by checking that no more failure warnings are logged after success
		const warnCalls = (mockLogger.warn as MockedFunction<any>).mock.calls;
		const failureWarningCalls = warnCalls.filter((call) =>
			call[0].includes("consecutive auto-refresh attempts"),
		);

		// Should have warnings for the first 2 failures, but not after success
		expect(failureWarningCalls).toHaveLength(2);
	});

	it("should handle exceptions in sendDummyMessage and track failures", async () => {
		// Insert an account (past rate_limit_reset to trigger refresh)
		const pastTime = Date.now() - 1000; // 1 second ago
		db.prepare(`
      INSERT INTO accounts (id, name, provider, refresh_token, rate_limit_reset, auto_refresh_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			"exception-account-6",
			"exception-account",
			"anthropic",
			"token",
			pastTime,
			1,
		);

		// Mock fetch to throw an exception
		const fetchMock = vi.fn().mockImplementation(() => {
			throw new Error("Network error");
		});
		global.fetch = fetchMock as any;

		// Call checkAndRefresh to trigger the exception handling
		await (scheduler as any).checkAndRefresh();

		// Check that the fetch was called (meaning the account was selected for refresh)
		expect(fetchMock).toHaveBeenCalled();

		// Check that the exception was logged
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"Error sending auto-refresh message to account exception-account",
			),
		);

		// Check that failure was tracked for exception
		const warnCalls = (mockLogger.warn as MockedFunction<any>).mock.calls;
		const exceptionFailureCalls = warnCalls.filter(
			(call) =>
				call[0].includes("has failed") &&
				call[0].includes("consecutive auto-refresh attempts (exception)"),
		);

		expect(exceptionFailureCalls).toHaveLength(1);
	});
});
