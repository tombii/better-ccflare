import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { RuntimeConfig } from "@better-ccflare/config";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers";

const mockTrackClientVersion = mock();
const mockPrepareRequestBody = mock();
const mockInterceptAndModifyRequest = mock();
const mockCreateRequestMetadata = mock();
const mockSelectAccountsForRequest = mock();
const mockProxyUnauthenticated = mock();
const mockProxyWithAccount = mock();
const mockValidateProviderPath = mock();
const mockIsRefreshTokenLikelyExpired = mock(() => false);
const requestEvents = { emit: mock() };

class MockServiceUnavailableError extends Error {
	constructor(
		message: string,
		public provider: string,
	) {
		super(message);
		this.name = "ServiceUnavailableError";
	}
}

class MockProviderError extends Error {}

mock.module("@better-ccflare/core", () => ({
	logError: mock(),
	ProviderError: MockProviderError,
	requestEvents,
	ServiceUnavailableError: MockServiceUnavailableError,
	trackClientVersion: mockTrackClientVersion,
}));

mock.module("./handlers", () => ({
	createRequestMetadata: mockCreateRequestMetadata,
	ERROR_MESSAGES: {
		ALL_ACCOUNTS_FAILED: "All accounts failed to proxy the request",
	},
	interceptAndModifyRequest: mockInterceptAndModifyRequest,
	isRefreshTokenLikelyExpired: mockIsRefreshTokenLikelyExpired,
	prepareRequestBody: mockPrepareRequestBody,
	proxyUnauthenticated: mockProxyUnauthenticated,
	proxyWithAccount: mockProxyWithAccount,
	selectAccountsForRequest: mockSelectAccountsForRequest,
	TIMING: { WORKER_SHUTDOWN_DELAY: 100 },
	validateProviderPath: mockValidateProviderPath,
}));

mock.module("./inline-worker", () => ({
	EMBEDDED_WORKER_CODE: "",
}));

const { handleProxy } = await import("./proxy");

function createAccount(id: string, name: string): Account {
	return {
		id,
		name,
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
	};
}

function createContext(): ProxyContext {
	return {
		strategy: "priority",
		dbOps: {} as ProxyContext["dbOps"],
		runtime: {} as RuntimeConfig,
		provider: {
			name: "anthropic",
		} as ProxyContext["provider"],
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: async (operation: () => unknown) => operation(),
		} as ProxyContext["asyncWriter"],
		usageWorker: {
			postMessage: () => {},
		} as ProxyContext["usageWorker"],
	};
}

describe("handleProxy failover", () => {
	beforeEach(() => {
		mockTrackClientVersion.mockReset();
		mockPrepareRequestBody.mockReset();
		mockInterceptAndModifyRequest.mockReset();
		mockCreateRequestMetadata.mockReset();
		mockSelectAccountsForRequest.mockReset();
		mockProxyUnauthenticated.mockReset();
		mockProxyWithAccount.mockReset();
		mockValidateProviderPath.mockReset();
		mockIsRefreshTokenLikelyExpired.mockReset();
		requestEvents.emit.mockReset();
	});

	it("tries the next account when the first account attempt fails", async () => {
		const accountA = createAccount("account-a", "Account A");
		const accountB = createAccount("account-b", "Account B");
		const successResponse = new Response("ok", { status: 200 });

		mockPrepareRequestBody.mockResolvedValue({ buffer: null });
		mockInterceptAndModifyRequest.mockResolvedValue({
			modifiedBody: null,
			agentUsed: null,
			originalModel: null,
			appliedModel: null,
		});
		mockCreateRequestMetadata.mockReturnValue({
			id: "request-1",
			timestamp: Date.now(),
			agentUsed: null,
		});
		mockSelectAccountsForRequest.mockResolvedValue([accountA, accountB]);
		mockProxyWithAccount
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(successResponse);

		const response = await handleProxy(
			new Request("https://proxy.local/v1/messages", { method: "POST" }),
			new URL("https://proxy.local/v1/messages"),
			createContext(),
		);

		expect(response).toBe(successResponse);
		expect(mockProxyWithAccount).toHaveBeenCalledTimes(2);
		expect(mockProxyWithAccount.mock.calls[0]?.[2]).toBe(accountA);
		expect(mockProxyWithAccount.mock.calls[1]?.[2]).toBe(accountB);
	});
});
