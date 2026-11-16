import { afterEach, describe, expect, it } from "bun:test";
import { ValidationError } from "@better-ccflare/core";
import { setReasoningEffortOverrides } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { AnthropicProvider } from "../providers/anthropic/provider";
import { AnthropicCompatibleProvider } from "../providers/anthropic-compatible/provider";
import { KiloProvider } from "../providers/kilo/provider";
import { MetaProvider } from "../providers/meta/provider";
import { OpenAICompatibleProvider } from "../providers/openai/provider";
import { OpenRouterProvider } from "../providers/openrouter/provider";
import { VertexAIProvider } from "../providers/vertex-ai/provider";

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "acc",
		provider: "anthropic-compatible",
		refresh_token: "key",
		access_token: null,
		expires_at: null,
		api_key: "key",
		custom_endpoint: null,
		model_mappings: null,
		priority: 0,
		paused: false,
		...overrides,
	} as unknown as Account;
}

function messagesRequest(body: Record<string, unknown>): Request {
	return new Request("http://localhost/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			max_tokens: 100,
			messages: [{ role: "user", content: "hi" }],
			...body,
		}),
	});
}

async function outbound(
	provider: { transformRequestBody(r: Request, a?: Account): Promise<Request> },
	body: Record<string, unknown>,
	acc: Account,
): Promise<Record<string, unknown>> {
	const transformed = await provider.transformRequestBody(
		messagesRequest(body),
		acc,
	);
	return (await transformed.json()) as Record<string, unknown>;
}

afterEach(() => {
	setReasoningEffortOverrides(null);
});

describe("anthropic-compatible outbound effort", () => {
	const provider = new AnthropicCompatibleProvider();
	const acc = account();

	it("converts internal reasoning.effort to Claude's output_config.effort", async () => {
		const body = await outbound(
			provider,
			{ model: "claude-sonnet-4-6", reasoning: { effort: "high" } },
			acc,
		);
		expect(body.output_config).toEqual({ effort: "high" });
		expect(body.reasoning).toBeUndefined();
	});

	it("keeps other output_config keys when adding effort", async () => {
		const format = { type: "json_schema", schema: { type: "object" } };
		const body = await outbound(
			provider,
			{
				model: "claude-sonnet-4-6",
				reasoning: { effort: "low" },
				output_config: { format },
			},
			acc,
		);
		expect(body.output_config).toEqual({ format, effort: "low" });
	});

	it("never overrides a native output_config.effort but still strips reasoning", async () => {
		const body = await outbound(
			provider,
			{
				model: "claude-sonnet-4-6",
				reasoning: { effort: "low" },
				output_config: { effort: "max" },
			},
			acc,
		);
		expect(body.output_config).toEqual({ effort: "max" });
		expect(body.reasoning).toBeUndefined();
	});

	it("does not invent an effort", async () => {
		const body = await outbound(provider, { model: "claude-sonnet-4-6" }, acc);
		expect(body.output_config).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
	});

	it("clamps via the shared resolver (built-in table and override)", async () => {
		const haiku = await outbound(
			provider,
			{ model: "claude-haiku-4-5", reasoning: { effort: "max" } },
			acc,
		);
		expect(haiku.output_config).toEqual({ effort: "medium" });

		setReasoningEffortOverrides({ "glm-9": ["low", "high"] });
		const glm = await outbound(
			provider,
			{ model: "glm-9", reasoning: { effort: "xhigh" } },
			acc,
		);
		expect(glm.output_config).toEqual({ effort: "high" });
	});

	it("clamps against the mapped model, not the requested alias", async () => {
		setReasoningEffortOverrides({ "upstream-model": ["low"] });
		const mapped = account({
			model_mappings: JSON.stringify({ sonnet: "upstream-model" }),
		} as Partial<Account>);
		const body = await outbound(
			provider,
			{ model: "claude-sonnet-4-6", reasoning: { effort: "high" } },
			mapped,
		);
		expect(body.model).toBe("upstream-model");
		expect(body.output_config).toEqual({ effort: "low" });
	});

	it("rejects an invalid effort", async () => {
		await expect(
			provider.transformRequestBody(
				messagesRequest({
					model: "claude-sonnet-4-6",
					reasoning: { effort: "extreme" },
				}),
				acc,
			),
		).rejects.toThrow(ValidationError);
	});
});

describe("native anthropic provider shares the conversion", () => {
	it("converts reasoning.effort to output_config.effort", async () => {
		const body = await outbound(
			new AnthropicProvider(),
			{ model: "claude-opus-4-7", reasoning: { effort: "xhigh" } },
			account({ provider: "anthropic" }),
		);
		expect(body.output_config).toEqual({ effort: "xhigh" });
		expect(body.reasoning).toBeUndefined();
	});

	it("leaves a request without reasoning untouched", async () => {
		const body = await outbound(
			new AnthropicProvider(),
			{ model: "claude-opus-4-7", output_config: { effort: "low" } },
			account({ provider: "anthropic" }),
		);
		expect(body.output_config).toEqual({ effort: "low" });
		expect(body.reasoning).toBeUndefined();
	});
});

describe("other Anthropic-shaped providers with their own body transform", () => {
	it("Vertex AI gets output_config.effort and no reasoning key", async () => {
		const body = await outbound(
			new VertexAIProvider(),
			{ model: "claude-sonnet-4-6", reasoning: { effort: "high" } },
			account({ provider: "vertex-ai" }),
		);
		expect(body.output_config).toEqual({ effort: "high" });
		expect(body.reasoning).toBeUndefined();
	});

	it("Vertex AI clamps against the mapped model it actually calls", async () => {
		const provider = new VertexAIProvider();
		const acc = account({
			provider: "vertex-ai",
			custom_endpoint: JSON.stringify({ projectId: "p", region: "global" }),
			model_mappings: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
		} as Partial<Account>);
		const request = messagesRequest({
			model: "claude-sonnet-4-6",
			reasoning: { effort: "high" },
		});
		provider.prepareRequest(request, await request.clone().arrayBuffer(), acc);
		const transformed = await provider.transformRequestBody(request, acc);
		const body = (await transformed.json()) as Record<string, unknown>;
		expect(body.output_config).toEqual({ effort: "medium" });
		expect(body.model).toBeUndefined();
	});

	it("Vertex AI applies an override keyed to the mapped model", async () => {
		setReasoningEffortOverrides({ "claude-haiku-4-5": ["low"] });
		const provider = new VertexAIProvider();
		const acc = account({
			provider: "vertex-ai",
			custom_endpoint: JSON.stringify({ projectId: "p", region: "global" }),
			model_mappings: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
		} as Partial<Account>);
		const request = messagesRequest({
			model: "claude-sonnet-4-6",
			reasoning: { effort: "high" },
		});
		provider.prepareRequest(request, await request.clone().arrayBuffer(), acc);
		const transformed = await provider.transformRequestBody(request, acc);
		const body = (await transformed.json()) as Record<string, unknown>;
		expect(body.output_config).toEqual({ effort: "low" });
	});

	it("Vertex AI falls back to the mapped model when prepareRequest did not run", async () => {
		const body = await outbound(
			new VertexAIProvider(),
			{ model: "claude-sonnet-4-6", reasoning: { effort: "high" } },
			account({
				provider: "vertex-ai",
				model_mappings: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
			} as Partial<Account>),
		);
		expect(body.output_config).toEqual({ effort: "medium" });
	});

	it("Meta gets output_config.effort and no reasoning key", async () => {
		const request = new Request("https://api.meta.ai/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "muse-spark",
				max_tokens: 100,
				messages: [{ role: "user", content: "hi" }],
				reasoning: { effort: "low" },
			}),
		});
		const transformed = await new MetaProvider().transformRequestBody(
			request,
			account({ provider: "meta" }),
		);
		const body = (await transformed.json()) as Record<string, unknown>;
		expect(body.output_config).toEqual({ effort: "low" });
		expect(body.reasoning).toBeUndefined();
	});
});

describe("openrouter (native) outbound effort", () => {
	it("keeps OpenRouter's reasoning: { effort } and clamps it", async () => {
		setReasoningEffortOverrides({
			"deepseek-v4.1-flash": ["low", "high", "max"],
		});
		const body = await outbound(
			new OpenRouterProvider(),
			{
				model: "deepseek/deepseek-v4.1-flash",
				reasoning: { effort: "medium" },
			},
			account({ provider: "openrouter" }),
		);
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(body.output_config).toBeUndefined();
	});
});

describe("openai-compatible outbound effort", () => {
	const generic = account({
		provider: "openai-compatible",
		custom_endpoint: "https://cliproxy.example.test/v1",
	});

	it("emits the standard reasoning_effort for generic endpoints", async () => {
		const body = await outbound(
			new OpenAICompatibleProvider(),
			{ model: "grok-4.7-build-fast", reasoning: { effort: "high" } },
			generic,
		);
		expect(body.reasoning_effort).toBe("high");
		expect(body.reasoning).toBeUndefined();
	});

	it("clamps via the override map", async () => {
		setReasoningEffortOverrides({
			"grok-4.7-build-fast": ["low", "medium", "high", "xhigh"],
		});
		const body = await outbound(
			new OpenAICompatibleProvider(),
			{ model: "grok-4.7-build-fast", reasoning: { effort: "max" } },
			generic,
		);
		expect(body.reasoning_effort).toBe("xhigh");
	});

	it("does not invent an effort", async () => {
		const body = await outbound(
			new OpenAICompatibleProvider(),
			{ model: "grok-4.7-build-fast" },
			generic,
		);
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
	});

	it("keeps reasoning: { effort } for an openrouter.ai endpoint", async () => {
		const body = await outbound(
			new OpenAICompatibleProvider(),
			{ model: "x-ai/grok-5", reasoning: { effort: "high" } },
			account({
				provider: "openai-compatible",
				custom_endpoint: "https://openrouter.ai/api/v1",
			}),
		);
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("keeps reasoning: { effort } for the OpenRouter-shaped Kilo gateway", async () => {
		const body = await outbound(
			new KiloProvider(),
			{ model: "x-ai/grok-5", reasoning: { effort: "high" } },
			account({ provider: "kilo" }),
		);
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body.reasoning_effort).toBeUndefined();
	});
});
