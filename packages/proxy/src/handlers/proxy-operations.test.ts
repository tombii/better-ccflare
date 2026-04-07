import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { RuntimeConfig } from "@better-ccflare/config";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";

const mockMakeProxyRequest = mock();
const mockValidateProviderPath = mock();
const mockProcessProxyResponse = mock();
const mockHandleProxyError = mock();
const mockGetValidAccessToken = mock();
const mockForwardToClient = mock();
const mockGetProvider = mock();
const mockLogError = mock();

class MockProviderError extends Error {}

mock.module("@better-ccflare/core", () => ({
	logError: mockLogError,
	ProviderError: MockProviderError,
}));

mock.module("@better-ccflare/providers", () => ({
	getProvider: mockGetProvider,
}));

mock.module("../response-handler", () => ({
	forwardToClient: mockForwardToClient,
}));

mock.module("./request-handler", () => ({
	makeProxyRequest: mockMakeProxyRequest,
	validateProviderPath: mockValidateProviderPath,
}));

mock.module("./response-processor", () => ({
	handleProxyError: mockHandleProxyError,
	processProxyResponse: mockProcessProxyResponse,
}));

mock.module("./token-manager", () => ({
	getValidAccessToken: mockGetValidAccessToken,
}));

const { proxyWithAccount } = await import("./proxy-operations");

function createAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-1",
		name: "Account One",
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
		...overrides,
	};
}

function createRequestMeta(): RequestMeta {
	return {
		id: "request-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		agentUsed: null,
	};
}

function createContext(provider: Record<string, unknown>): ProxyContext {
	return {
		strategy: "priority",
		dbOps: {} as ProxyContext["dbOps"],
		runtime: {} as RuntimeConfig,
		provider: provider as ProxyContext["provider"],
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: async (operation: () => unknown) => operation(),
		} as ProxyContext["asyncWriter"],
		usageWorker: {
			postMessage: () => {},
		} as ProxyContext["usageWorker"],
	};
}

describe("proxyWithAccount auth failover handling", () => {
	beforeEach(() => {
		mockMakeProxyRequest.mockReset();
		mockValidateProviderPath.mockReset();
		mockProcessProxyResponse.mockReset();
		mockHandleProxyError.mockReset();
		mockGetValidAccessToken.mockReset();
		mockForwardToClient.mockReset();
		mockGetProvider.mockReset();
		mockLogError.mockReset();
	});

	it("returns null for upstream 401 responses so callers can fail over", async () => {
		const provider = {
			name: "anthropic",
			prepareHeaders: () => new Headers(),
			buildUrl: () => "https://example.com/v1/messages",
			processResponse: async (response: Response) => response,
		};
		const account = createAccount();
		const ctx = createContext(provider);

		mockGetProvider.mockReturnValue(provider);
		mockGetValidAccessToken.mockResolvedValue("access-token");
		mockMakeProxyRequest.mockResolvedValue(
			new Response("unauthorized", { status: 401 }),
		);

		const result = await proxyWithAccount(
			new Request("https://proxy.local/v1/messages", { method: "POST" }),
			new URL("https://proxy.local/v1/messages"),
			account,
			createRequestMeta(),
			null,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(mockProcessProxyResponse).not.toHaveBeenCalled();
		expect(mockForwardToClient).not.toHaveBeenCalled();
	});

	it("keeps 429 handling unchanged", async () => {
		const provider = {
			name: "anthropic",
			prepareHeaders: () => new Headers(),
			buildUrl: () => "https://example.com/v1/messages",
			processResponse: async (response: Response) => response,
		};
		const account = createAccount();
		const ctx = createContext(provider);

		mockGetProvider.mockReturnValue(provider);
		mockGetValidAccessToken.mockResolvedValue("access-token");
		mockMakeProxyRequest.mockResolvedValue(
			new Response("rate limited", { status: 429 }),
		);
		mockProcessProxyResponse.mockResolvedValue(true);

		const result = await proxyWithAccount(
			new Request("https://proxy.local/v1/messages", { method: "POST" }),
			new URL("https://proxy.local/v1/messages"),
			account,
			createRequestMeta(),
			null,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(mockProcessProxyResponse).toHaveBeenCalledTimes(1);
		expect(mockForwardToClient).not.toHaveBeenCalled();
	});
});
