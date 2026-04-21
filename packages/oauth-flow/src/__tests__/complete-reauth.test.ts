import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import type {
	OAuthProviderConfig,
	OAuthTokens,
} from "@better-ccflare/providers";
import { OAuthFlow } from "../index";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeAdapter(runSpy: ReturnType<typeof mock>) {
	return {
		run: runSpy,
		get: mock(async () => null),
		all: mock(async () => []),
		close: mock(async () => {}),
	};
}

function makeDbOps(runSpy: ReturnType<typeof mock>): DatabaseOperations {
	return {
		getAdapter: () => makeAdapter(runSpy),
		getAllAccounts: mock(async () => []),
	} as unknown as DatabaseOperations;
}

function makeConfig(): Config {
	return {
		getRuntime: () => ({ clientId: "test-client-id" }),
	} as unknown as Config;
}

const testOauthConfig: OAuthProviderConfig = {
	clientId: "test-client-id",
	authorizationEndpoint: "https://example.com/oauth/authorize",
	tokenEndpoint: "https://example.com/oauth/token",
	redirectUri: "http://localhost/callback",
	scopes: ["openid"],
};

const testFlowData = {
	sessionId: "00000000-0000-0000-0000-000000000001",
	authUrl: "",
	pkce: { verifier: "test-verifier", challenge: "test-challenge" },
	oauthConfig: testOauthConfig,
	mode: "claude-oauth" as const,
};

// ---------------------------------------------------------------------------
// Mock @better-ccflare/providers so no real OAuth calls go out.
// The mock must be registered before the module under test is imported.
// ---------------------------------------------------------------------------

const mockExchangeCode = mock(
	async (
		_code: string,
		_verifier: string,
		_config: OAuthProviderConfig,
	): Promise<OAuthTokens> => ({
		accessToken: "new-access-token",
		refreshToken: "new-refresh-token",
		expiresAt: Date.now() + 3_600_000,
	}),
);

mock.module("@better-ccflare/providers", () => ({
	getOAuthProvider: (_name: string) => ({
		exchangeCode: mockExchangeCode,
		getOAuthConfig: (_mode: string) => ({ ...testOauthConfig }),
		generateAuthUrl: mock(() => "https://example.com/oauth/authorize?mock"),
	}),
	generatePKCE: mock(async () => ({
		verifier: "mock-verifier",
		challenge: "mock-challenge",
	})),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuthFlow.completeReauth", () => {
	let runSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		runSpy = mock(async () => ({ changes: 1 }));
		mockExchangeCode.mockClear();
	});

	it("should throw when id is not provided", async () => {
		const flow = new OAuthFlow(makeDbOps(runSpy), makeConfig());

		await expect(
			flow.completeReauth(
				{ sessionId: "s1", code: "c1", name: "acct" },
				testFlowData,
			),
		).rejects.toThrow(/id.*required/i);
	});

	it("should UPDATE refresh_token, access_token, expires_at for claude-oauth mode", async () => {
		const flow = new OAuthFlow(makeDbOps(runSpy), makeConfig());
		const accountId = "aaaaaaaa-0000-0000-0000-000000000001";

		await flow.completeReauth(
			{ sessionId: "s1", code: "auth-code", name: "acct", id: accountId },
			testFlowData,
		);

		// exchangeCode should have been called once with our code and verifier
		expect(mockExchangeCode).toHaveBeenCalledTimes(1);
		const [codeArg, verifierArg] = mockExchangeCode.mock.calls[0];
		expect(codeArg).toBe("auth-code");
		expect(verifierArg).toBe("test-verifier");

		// The adapter run() should have been called once with an UPDATE
		expect(runSpy).toHaveBeenCalledTimes(1);
		const [sql, params] = runSpy.mock.calls[0];
		expect(sql).toMatch(/UPDATE\s+accounts/i);
		expect(sql).toMatch(/refresh_token/i);
		expect(sql).toMatch(/access_token/i);
		expect(sql).toMatch(/expires_at/i);
		// Params: [refreshToken, accessToken, expiresAt, accountId]
		expect(params[0]).toBe("new-refresh-token");
		expect(params[1]).toBe("new-access-token");
		expect(typeof params[2]).toBe("number");
		expect(params[3]).toBe(accountId);
	});

	it("should UPDATE api_key for console mode (no refreshToken)", async () => {
		// Override exchangeCode to return tokens without refreshToken (console mode)
		mockExchangeCode.mockImplementation(async () => ({
			accessToken: "console-access-token",
			refreshToken: null,
			expiresAt: Date.now() + 3_600_000,
		}));

		// Stub createAnthropicApiKey network call via fetch mock
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async (_url: string | URL | Request) =>
				new Response(JSON.stringify({ raw_key: "sk-console-api-key" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof fetch;

		try {
			const flow = new OAuthFlow(makeDbOps(runSpy), makeConfig());
			const accountId = "bbbbbbbb-0000-0000-0000-000000000002";

			const consoleFlowData = { ...testFlowData, mode: "console" as const };

			await flow.completeReauth(
				{
					sessionId: "s2",
					code: "auth-code-2",
					name: "console-acct",
					id: accountId,
				},
				consoleFlowData,
			);

			// adapter run() should have been called once with UPDATE api_key
			expect(runSpy).toHaveBeenCalledTimes(1);
			const [sql, params] = runSpy.mock.calls[0];
			expect(sql).toMatch(/UPDATE\s+accounts/i);
			expect(sql).toMatch(/api_key/i);
			expect(params[0]).toBe("sk-console-api-key");
			expect(params[1]).toBe(accountId);
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("should propagate errors thrown by exchangeCode", async () => {
		mockExchangeCode.mockImplementation(async () => {
			throw new Error("token exchange failed");
		});

		const flow = new OAuthFlow(makeDbOps(runSpy), makeConfig());

		await expect(
			flow.completeReauth(
				{ sessionId: "s3", code: "bad-code", name: "acct", id: "some-id" },
				testFlowData,
			),
		).rejects.toThrow("token exchange failed");

		// No DB write should have happened
		expect(runSpy).not.toHaveBeenCalled();
	});
});
