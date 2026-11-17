import { describe, expect, it } from "bun:test";
import {
	getProviderFromMode,
	PROVIDER_CONFIG,
	PROVIDER_NAMES,
} from "@better-ccflare/types";
import { getProvider } from "../index";
import { BaseAnthropicCompatibleProvider } from "../providers/base-anthropic-compatible";

const OPENCODE_GO_BASE = "https://opencode.ai/inference/go/anthropic";

describe("opencode-go provider registration", () => {
	it("is a known provider name", () => {
		expect(PROVIDER_NAMES.OPENCODE_GO).toBe("opencode-go");
	});

	it("maps the account mode to the provider name", () => {
		expect(getProviderFromMode("opencode-go")).toBe(PROVIDER_NAMES.OPENCODE_GO);
	});

	it("is returned by the registry", () => {
		const provider = getProvider("opencode-go");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("opencode-go");
	});

	it("is an Anthropic-compatible provider without OAuth", () => {
		const provider = getProvider("opencode-go");
		expect(provider).toBeInstanceOf(BaseAnthropicCompatibleProvider);
		expect(provider?.supportsOAuth()).toBe(false);
	});

	it("builds the messages URL without duplicating /v1", () => {
		const provider = getProvider("opencode-go");
		// The client path already carries `/v1`; the endpoint must not.
		const url = provider?.buildUrl("/v1/messages", "", undefined);
		expect(url).toBe(`${OPENCODE_GO_BASE}/v1/messages`);
		expect(url?.match(/\/v1\//g)?.length).toBe(1);
	});

	it("builds the models URL without duplicating /v1", () => {
		const provider = getProvider("opencode-go");
		const url = provider?.buildUrl("/v1/models", "", undefined);
		expect(url).toBe(`${OPENCODE_GO_BASE}/v1/models`);
		expect(url?.match(/\/v1\//g)?.length).toBe(1);
	});

	it("builds the count_tokens URL without duplicating /v1", () => {
		const provider = getProvider("opencode-go");
		expect(provider?.buildUrl("/v1/messages/count_tokens", "", undefined)).toBe(
			`${OPENCODE_GO_BASE}/v1/messages/count_tokens`,
		);
	});

	it("authenticates with a Bearer Authorization header, not x-api-key", () => {
		const provider = getProvider("opencode-go");
		const headers = provider?.prepareHeaders(
			new Headers(),
			"secret",
			undefined,
		);
		expect(headers?.get("authorization")).toBe("Bearer secret");
		expect(headers?.get("x-api-key")).toBeNull();
	});

	it("replaces a client-supplied Authorization header with the Bearer token", () => {
		const provider = getProvider("opencode-go");
		const incoming = new Headers();
		incoming.set("Authorization", "Bearer client-key");
		const headers = provider?.prepareHeaders(incoming, "secret", undefined);
		expect(headers?.get("authorization")).toBe("Bearer secret");
	});

	it("has the DeepSeek flash default model", () => {
		const provider = getProvider("opencode-go");
		expect(provider?.getDefaultModel()).toBe("deepseek-v4.1-flash");
	});
});

describe("opencode-go provider config", () => {
	it("tracks usage and sessions but not OAuth", () => {
		const config = PROVIDER_CONFIG[PROVIDER_NAMES.OPENCODE_GO];
		expect(config).toBeDefined();
		expect(config.requiresSessionTracking).toBe(true);
		expect(config.supportsUsageTracking).toBe(true);
		expect(config.supportsOAuth).toBe(false);
		expect(config.defaultEndpoint).toBe(OPENCODE_GO_BASE);
	});
});
