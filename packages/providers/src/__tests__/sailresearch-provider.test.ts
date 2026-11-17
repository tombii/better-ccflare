import { describe, expect, it } from "bun:test";
import { getProviderFromMode, PROVIDER_NAMES } from "@better-ccflare/types";
import type { Account } from "@better-ccflare/types";
import { getProvider } from "../index";

const account = (overrides: Partial<Account> = {}): Account =>
	({
		id: "sailresearch-1",
		name: "sailresearch-test",
		provider: "sailresearch",
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

describe("sailresearch provider registration", () => {
	it("is a known provider name", () => {
		expect(PROVIDER_NAMES.SAILRESEARCH).toBe("sailresearch");
	});

	it("maps the account mode to the provider name", () => {
		expect(getProviderFromMode("sailresearch")).toBe("sailresearch");
	});

	it("is returned by the registry", () => {
		const provider = getProvider("sailresearch");
		expect(provider).toBeDefined();
		expect(provider?.name).toBe("sailresearch");
	});

	it("builds the Sail messages URL without duplicating /v1", () => {
		const provider = getProvider("sailresearch");
		// The client path already carries `/v1`; the endpoint must not.
		expect(provider?.buildUrl("/v1/messages", "", undefined)).toBe(
			"https://api.sailresearch.com/v1/messages",
		);
	});

	it("builds the Sail count_tokens URL without duplicating /v1", () => {
		const provider = getProvider("sailresearch");
		expect(
			provider?.buildUrl("/v1/messages/count_tokens", "", undefined),
		).toBe("https://api.sailresearch.com/v1/messages/count_tokens");
	});

	it("authenticates with a Bearer Authorization header, not x-api-key", () => {
		const provider = getProvider("sailresearch");
		const headers = provider?.prepareHeaders(
			new Headers(),
			"secret",
			undefined,
		);
		expect(headers?.get("authorization")).toBe("Bearer secret");
		expect(headers?.get("x-api-key")).toBeNull();
	});
});

describe("sailresearch model mapping (no mapModelForRequest override)", () => {
	// Regression guard for the mapModelForRequest extraction in
	// BaseAnthropicCompatibleProvider: a provider that does NOT override the
	// hook must keep the base behaviour — map only through account mappings and
	// leave the model untouched otherwise, even though it registers its own
	// family defaults.
	it("leaves a Claude id unchanged when the account has no mappings", async () => {
		const provider = getProvider("sailresearch");
		const transformed = await provider?.transformRequestBody(
			messagesRequest("claude-sonnet-4-5"),
			account(),
		);
		const body = await transformed?.json();
		expect(body.model).toBe("claude-sonnet-4-5");
	});

	it("still maps through an account mapping", async () => {
		const provider = getProvider("sailresearch");
		const transformed = await provider?.transformRequestBody(
			messagesRequest("claude-sonnet-4-5"),
			account({ model_mappings: JSON.stringify({ sonnet: "sail-sonnet" }) }),
		);
		const body = await transformed?.json();
		expect(body.model).toBe("sail-sonnet");
	});
});
