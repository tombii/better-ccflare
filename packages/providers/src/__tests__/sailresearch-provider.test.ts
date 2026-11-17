import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setForceAccountModel } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { getProviderFromMode, PROVIDER_NAMES } from "@better-ccflare/types";
import { getProvider } from "../index";
import { setProviderModelDefaultOverrides } from "../provider-model-defaults";

const SAIL_DEFAULT = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

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

describe("sailresearch model mapping", () => {
	// Sail serves only its own ids, so an unmapped Claude Code request must be
	// translated to the registered family default. Global switches are reset
	// around every test so a failing assertion can never leak state.
	beforeEach(() => {
		setForceAccountModel(false);
		setProviderModelDefaultOverrides(undefined);
	});

	afterEach(() => {
		setForceAccountModel(false);
		setProviderModelDefaultOverrides(undefined);
	});

	async function transformedModel(
		model: string,
		acc: Account = account(),
	): Promise<string> {
		const provider = getProvider("sailresearch");
		const transformed = await provider?.transformRequestBody(
			messagesRequest(model),
			acc,
		);
		const body = await transformed?.json();
		return body.model;
	}

	it.each([
		"claude-fable-4-5",
		"claude-opus-4-5",
		"claude-sonnet-4-5",
		"claude-haiku-4-5",
	])("maps %s to the Sail default when the account has no mappings", async (model) => {
		expect(await transformedModel(model)).toBe(SAIL_DEFAULT);
	});

	it("leaves a non-Claude id unchanged", async () => {
		expect(await transformedModel(SAIL_DEFAULT)).toBe(SAIL_DEFAULT);
	});

	it("maps through a family account mapping", async () => {
		expect(
			await transformedModel(
				"claude-sonnet-4-5",
				account({ model_mappings: JSON.stringify({ sonnet: "sail-sonnet" }) }),
			),
		).toBe("sail-sonnet");
	});

	it("maps through an exact-id account mapping", async () => {
		expect(
			await transformedModel(
				"claude-sonnet-4-5",
				account({
					model_mappings: JSON.stringify({ "claude-sonnet-4-5": "sail-exact" }),
				}),
			),
		).toBe("sail-exact");
	});

	it("prefers an operator override over the built-in default", async () => {
		try {
			setProviderModelDefaultOverrides({
				sailresearch: { sonnet: "operator-model" },
			});
			expect(await transformedModel("claude-sonnet-4-5")).toBe(
				"operator-model",
			);
		} finally {
			setProviderModelDefaultOverrides(undefined);
		}
	});

	it("leaves the model untouched when force-account-model is on", async () => {
		try {
			setForceAccountModel(true);
			expect(await transformedModel("claude-sonnet-4-5")).toBe(
				"claude-sonnet-4-5",
			);
		} finally {
			setForceAccountModel(false);
		}
	});
});
