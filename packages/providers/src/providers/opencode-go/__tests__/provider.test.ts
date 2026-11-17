import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setForceAccountModel } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import {
	clearDerivedProviderModelDefaults,
	resolveProviderModelDefault,
	setProviderModelDefaultOverrides,
} from "../../../provider-model-defaults";
// Import the module under test first: its registration side effect must run
// before any resolver call.
import { OpencodeGoProvider } from "../provider";

const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

const account = (overrides: Partial<Account> = {}): Account =>
	({
		id: "opencode-go-1",
		name: "opencode-go-test",
		provider: "opencode-go",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		model_mappings: null,
		model_fallbacks: null,
		custom_endpoint: null,
		...overrides,
	}) as Account;

function messagesRequest(model: string): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			max_tokens: 32,
			messages: [{ role: "user", content: "hello" }],
		}),
	});
}

describe("OpencodeGoProvider", () => {
	beforeEach(() => {
		setProviderModelDefaultOverrides({});
		clearDerivedProviderModelDefaults();
		setForceAccountModel(false);
	});

	afterEach(() => {
		setProviderModelDefaultOverrides({});
		clearDerivedProviderModelDefaults();
		setForceAccountModel(false);
	});

	it("registers deepseek-v4.1-flash as the default for every Claude family", () => {
		for (const family of FAMILIES) {
			expect(resolveProviderModelDefault("opencode-go", family)).toBe(
				"deepseek-v4.1-flash",
			);
		}
	});

	it("has the expected identity and default model", () => {
		const provider = new OpencodeGoProvider();
		expect(provider.name).toBe("opencode-go");
		expect(provider.getDefaultModel()).toBe("deepseek-v4.1-flash");
		expect(provider.getEndpoint()).toBe(
			"https://opencode.ai/inference/go/anthropic",
		);
	});

	describe("refreshToken (API key passthrough)", () => {
		it("returns the api_key as the access token", async () => {
			const provider = new OpencodeGoProvider();
			const result = await provider.refreshToken(
				account({ api_key: "go-key" }),
				"client",
			);
			expect(result.accessToken).toBe("go-key");
			expect(result.refreshToken).toBe("");
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});

		it("falls back to refresh_token when api_key is absent", async () => {
			const provider = new OpencodeGoProvider();
			const result = await provider.refreshToken(
				account({ refresh_token: "legacy-key" }),
				"client",
			);
			expect(result.accessToken).toBe("legacy-key");
		});

		it("throws when no key is available", async () => {
			const provider = new OpencodeGoProvider();
			await expect(provider.refreshToken(account(), "client")).rejects.toThrow(
				"No API key available for account opencode-go-test",
			);
		});
	});

	describe("transformRequestBody", () => {
		it("passes an unknown model id through unchanged", async () => {
			const provider = new OpencodeGoProvider();
			const transformed = await provider.transformRequestBody(
				messagesRequest("kimi-k2.5"),
				account(),
			);
			const body = await transformed.json();
			expect(body.model).toBe("kimi-k2.5");
		});

		it("leaves the default model id unchanged", async () => {
			const provider = new OpencodeGoProvider();
			const transformed = await provider.transformRequestBody(
				messagesRequest("deepseek-v4.1-flash"),
				account(),
			);
			const body = await transformed.json();
			expect(body.model).toBe("deepseek-v4.1-flash");
		});

		it("maps a Claude family name through an account mapping", async () => {
			const provider = new OpencodeGoProvider();
			const transformed = await provider.transformRequestBody(
				messagesRequest("claude-sonnet-4-5-20250929"),
				account({
					model_mappings: JSON.stringify({ sonnet: "deepseek-v4.1-flash" }),
				}),
			);
			const body = await transformed.json();
			expect(body.model).toBe("deepseek-v4.1-flash");
		});

		it("maps a Claude family name to the registered default when the account mapping uses it", async () => {
			const provider = new OpencodeGoProvider();
			// The proxy seeds family keys with the registered default; assert
			// that combination end to end for every family.
			for (const family of FAMILIES) {
				const mapped = resolveProviderModelDefault("opencode-go", family);
				expect(mapped).toBe("deepseek-v4.1-flash");
				const transformed = await provider.transformRequestBody(
					messagesRequest(`claude-${family}-5`),
					account({ model_mappings: JSON.stringify({ [family]: mapped }) }),
				);
				const body = await transformed.json();
				expect(body.model).toBe("deepseek-v4.1-flash");
			}
		});

		it("maps each Claude family to the registered default with NO account mappings", async () => {
			const provider = new OpencodeGoProvider();
			for (const family of FAMILIES) {
				const transformed = await provider.transformRequestBody(
					messagesRequest(`claude-${family}-5`),
					account(),
				);
				const body = await transformed.json();
				expect(body.model).toBe("deepseek-v4.1-flash");
			}
		});

		it("maps a dated Claude id to the default with no account mappings", async () => {
			const provider = new OpencodeGoProvider();
			const transformed = await provider.transformRequestBody(
				messagesRequest("claude-sonnet-4-5-20250929"),
				account(),
			);
			const body = await transformed.json();
			expect(body.model).toBe("deepseek-v4.1-flash");
		});

		it("maps a Claude id to the default even with no account at all", async () => {
			const provider = new OpencodeGoProvider();
			const transformed = await provider.transformRequestBody(
				messagesRequest("claude-sonnet-4-5"),
			);
			const body = await transformed.json();
			expect(body.model).toBe("deepseek-v4.1-flash");
		});

		it("lets an explicit account mapping win over the built-in default", async () => {
			const provider = new OpencodeGoProvider();
			const transformed = await provider.transformRequestBody(
				messagesRequest("claude-sonnet-4-5"),
				account({ model_mappings: JSON.stringify({ sonnet: "glm-5.3" }) }),
			);
			const body = await transformed.json();
			expect(body.model).toBe("glm-5.3");
		});

		it("lets an operator override win over the built-in default", async () => {
			setProviderModelDefaultOverrides({
				"opencode-go": { sonnet: "qwen3.8-max" },
			});
			const provider = new OpencodeGoProvider();
			const transformed = await provider.transformRequestBody(
				messagesRequest("claude-sonnet-4-5"),
				account(),
			);
			const body = await transformed.json();
			expect(body.model).toBe("qwen3.8-max");
		});

		it("never rewrites the model while force-account-model is on", async () => {
			setForceAccountModel(true);
			try {
				const provider = new OpencodeGoProvider();
				const transformed = await provider.transformRequestBody(
					messagesRequest("claude-sonnet-4-5"),
					account(),
				);
				const body = await transformed.json();
				expect(body.model).toBe("claude-sonnet-4-5");
			} finally {
				setForceAccountModel(false);
			}
		});
	});
});
