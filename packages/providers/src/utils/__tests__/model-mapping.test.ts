import { logBus } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import {
	getModelName,
	transformRequestBodyModel,
	transformRequestBodyModelForce,
} from "../model-mapping";

describe("getModelName", () => {
	it("returns original model when no account mappings", () => {
		const result = getModelName("claude-sonnet-4-5-20250929", undefined);
		expect(result).toBe("claude-sonnet-4-5-20250929");
	});

	it("returns original model when account has no model_mappings", () => {
		const account = {
			id: "test-id",
			name: "test-account",
			provider: "test-provider",
			model_mappings: null,
		} as Account;

		const result = getModelName("claude-sonnet-4-5-20250929", account);
		expect(result).toBe("claude-sonnet-4-5-20250929");
	});

	it("handles exact model match", () => {
		const account = {
			id: "test-id",
			name: "test-account",
			provider: "test-provider",
			model_mappings: JSON.stringify({
				"claude-sonnet-4-5-20250929": "custom-sonnet",
			}),
		} as Account;

		const result = getModelName("claude-sonnet-4-5-20250929", account);
		expect(result).toBe("custom-sonnet");
	});

	it("handles pattern matching for sonnet", () => {
		const account = {
			id: "test-id",
			name: "test-account",
			provider: "test-provider",
			model_mappings: JSON.stringify({ sonnet: "custom-sonnet" }),
		} as Account;

		const result = getModelName("claude-sonnet-4-5-20250929", account);
		expect(result).toBe("custom-sonnet");
	});

	it("handles pattern matching for opus", () => {
		const account = {
			id: "test-id",
			name: "test-account",
			provider: "test-provider",
			model_mappings: JSON.stringify({ opus: "custom-opus" }),
		} as Account;

		const result = getModelName("claude-opus-4-1-20250805", account);
		expect(result).toBe("custom-opus");
	});

	it("handles pattern matching for haiku", () => {
		const account = {
			id: "test-id",
			name: "test-account",
			provider: "test-provider",
			model_mappings: JSON.stringify({ haiku: "custom-haiku" }),
		} as Account;

		const result = getModelName("claude-haiku-4-5-20251001", account);
		expect(result).toBe("custom-haiku");
	});
});

describe("transformRequestBodyModel", () => {
	it("transforms model when mapping exists", async () => {
		const requestBody = {
			model: "claude-sonnet-4-5-20250929",
			messages: [{ role: "user", content: "test" }],
		};

		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		const account = {
			id: "test-id",
			name: "test-account",
			provider: "test-provider",
			model_mappings: JSON.stringify({
				"claude-sonnet-4-5-20250929": "custom-sonnet",
			}),
		} as Account;

		const result = await transformRequestBodyModel(request, account);
		const resultBody = await result.json();

		expect(resultBody.model).toBe("custom-sonnet");
		expect(resultBody.messages).toEqual([{ role: "user", content: "test" }]);
	});

	it("preserves request when no transformation needed", async () => {
		const requestBody = {
			model: "claude-sonnet-4-5-20250929",
			messages: [{ role: "user", content: "test" }],
		};

		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		const result = await transformRequestBodyModel(request, undefined);
		const resultBody = await result.json();

		expect(resultBody.model).toBe("claude-sonnet-4-5-20250929");
		expect(resultBody.messages).toEqual([{ role: "user", content: "test" }]);
		// Unchanged body: the original Request is returned, not a re-serialised
		// copy.
		expect(result).toBe(request);
	});

	it("handles provider-specific mapping callback", async () => {
		const requestBody = {
			model: "claude-sonnet-4-5-20250929",
			messages: [{ role: "user", content: "test" }],
		};

		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		const result = await transformRequestBodyModel(
			request,
			undefined,
			(model) => `mapped-${model}`,
		);
		const resultBody = await result.json();

		expect(resultBody.model).toBe("mapped-claude-sonnet-4-5-20250929");
		expect(resultBody.messages).toEqual([{ role: "user", content: "test" }]);
	});

	it("handles request without model field", async () => {
		const requestBody = {
			messages: [{ role: "user", content: "test" }],
		};

		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		const result = await transformRequestBodyModel(request, undefined);
		const resultBody = await result.json();

		expect(resultBody.messages).toEqual([{ role: "user", content: "test" }]);
		expect(resultBody.model).toBeUndefined();
	});

	it("strips the internal Codex passthrough field before forwarding upstream", async () => {
		const requestBody = {
			model: "claude-sonnet-4-5-20250929",
			messages: [{ role: "user", content: "test" }],
			__better_ccflare_codex_passthrough: { store: true },
		};

		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		const result = await transformRequestBodyModel(request, undefined);
		const resultBody = await result.json();

		expect(resultBody).not.toHaveProperty("__better_ccflare_codex_passthrough");
		expect(resultBody.model).toBe("claude-sonnet-4-5-20250929");
	});
});

describe("transformRequestBodyModelForce", () => {
	it("forces model to target regardless of input", async () => {
		const requestBody = {
			model: "claude-sonnet-4-5-20250929",
			messages: [{ role: "user", content: "test" }],
		};

		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		const result = await transformRequestBodyModelForce(request, "MiniMax-M2");
		const resultBody = await result.json();

		expect(resultBody.model).toBe("MiniMax-M2");
		expect(resultBody.messages).toEqual([{ role: "user", content: "test" }]);
	});

	it("handles request without model field", async () => {
		const requestBody = {
			messages: [{ role: "user", content: "test" }],
		};

		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		const result = await transformRequestBodyModelForce(request, "MiniMax-M2");
		const resultBody = await result.json();

		// The model should not be added if it didn't exist originally
		expect(resultBody.messages).toEqual([{ role: "user", content: "test" }]);
		expect(resultBody.model).toBeUndefined();
	});

	it("handles invalid request body gracefully", async () => {
		const request = new Request("http://test.com", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "invalid json",
		});

		const result = await transformRequestBodyModelForce(request, "MiniMax-M2");

		// Should return original request when JSON parsing fails
		expect(result).toBe(request);
	});
});

describe("model transforms preserve the abort signal", () => {
	// Both transforms rebuild the Request from `request.url`, and a URL-based
	// rebuild does not inherit the signal. Losing it would detach a client
	// disconnect from the upstream fetch for every account with a model mapping.
	function signalledRequest(controller: AbortController, model = "sonnet") {
		return new Request("http://test.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, messages: [] }),
			signal: controller.signal,
		});
	}

	it("keeps the signal when transformRequestBodyModel rewrites the model", async () => {
		const controller = new AbortController();
		const request = signalledRequest(controller);

		const result = await transformRequestBodyModel(
			request,
			undefined,
			() => "mapped-model",
		);

		// A rewrite happened, so this must be a new Request object …
		expect(result).not.toBe(request);
		// … that still aborts together with the client.
		expect(result.signal.aborted).toBe(false);
		controller.abort();
		expect(result.signal.aborted).toBe(true);
	});

	it("keeps the signal when transformRequestBodyModelForce rewrites the model", async () => {
		const controller = new AbortController();
		const request = signalledRequest(controller);

		const result = await transformRequestBodyModelForce(request, "MiniMax-M2");

		expect(result).not.toBe(request);
		expect(result.signal.aborted).toBe(false);
		controller.abort();
		expect(result.signal.aborted).toBe(true);
	});

	it("passes the original request through when no rewrite is needed", async () => {
		const controller = new AbortController();
		const request = signalledRequest(controller, "same-model");

		const result = await transformRequestBodyModel(
			request,
			undefined,
			() => "same-model",
		);

		expect(result).toBe(request);
		controller.abort();
		expect(result.signal.aborted).toBe(true);
	});
});

describe("transformRequestBodyModel — provider routing suffix", () => {
	function post(body: unknown): Request {
		return new Request("http://test.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function openrouterAccount(
		mappings: Record<string, string | string[]> | null = null,
	): Account {
		return {
			id: "test-id",
			name: "openrouter-account",
			provider: "openrouter",
			model_mappings: mappings ? JSON.stringify(mappings) : null,
		} as Account;
	}

	function captureWarnings(): { warnings: string[]; restore: () => void } {
		const warnings: string[] = [];
		const listener = (event: { level: string; msg: string }) => {
			if (event.level === "WARN") warnings.push(event.msg);
		};
		logBus.on("log", listener);
		return { warnings, restore: () => logBus.off("log", listener) };
	}

	it("moves a suffix on a passthrough model into body.provider", async () => {
		const request = post({
			model: 'z-ai/glm-4.5-air:free {"ignore":["deepseek"],"sort":"price"}',
			messages: [],
		});
		const result = await transformRequestBodyModel(
			request,
			openrouterAccount(),
		);
		const body = await result.json();
		expect(body.model).toBe("z-ai/glm-4.5-air:free");
		expect(body.provider).toEqual({ ignore: ["deepseek"], sort: "price" });
	});

	it("strips the suffix before mapping and re-attaches routing to the mapped model", async () => {
		const request = post({
			model: 'claude-sonnet-4-5-20250929 {"only":["deepseek"]}',
			messages: [],
		});
		const account = openrouterAccount({
			"claude-sonnet-4-5-20250929":
				'deepseek/deepseek-v4.1-flash-1017 {"only":["deepseek"]}',
		});
		const result = await transformRequestBodyModel(request, account);
		const body = await result.json();
		expect(body.model).toBe("deepseek/deepseek-v4.1-flash-1017");
		// The mapping value's own routing applies — it names the upstream that
		// actually serves this model.
		expect(body.provider).toEqual({ only: ["deepseek"] });
	});

	it("keeps the request's routing when the mapped name has none", async () => {
		const request = post({
			model: 'claude-sonnet-4-5-20250929 {"sort":"price"}',
			messages: [],
		});
		const account = openrouterAccount({
			"claude-sonnet-4-5-20250929": "z-ai/glm-4.5-air:free",
		});
		const result = await transformRequestBodyModel(request, account);
		const body = await result.json();
		expect(body.model).toBe("z-ai/glm-4.5-air:free");
		expect(body.provider).toEqual({ sort: "price" });
	});

	it("applies routing on an unsupported provider through a provider-specific mapper", async () => {
		const request = post({
			model: 'claude-sonnet-4-5-20250929 {"sort":"price"}',
			messages: [],
		});
		const account = {
			id: "anthropic-id",
			name: "anthropic",
			provider: "anthropic",
			model_mappings: null,
		} as Account;
		const cap = captureWarnings();
		try {
			const result = await transformRequestBodyModel(
				request,
				account,
				(model) => model,
			);
			const body = await result.json();
			expect(body.model).toBe("claude-sonnet-4-5-20250929");
			expect("provider" in body).toBe(false);
			expect(cap.warnings.length).toBe(1);
			expect(cap.warnings[0]).toContain("anthropic");
		} finally {
			cap.restore();
		}
	});

	it("forwards routing for an unsupported known provider (no callback) as before", async () => {
		// Without an account the provider is unknown; the implicit path keeps
		// its historical behaviour and does not warn.
		const request = post({ model: 'some/model {"only":["x"]}', messages: [] });
		const cap = captureWarnings();
		try {
			const result = await transformRequestBodyModel(request, undefined);
			const body = await result.json();
			expect(body.model).toBe("some/model");
			expect(body.provider).toEqual({ only: ["x"] });
			expect(cap.warnings).toEqual([]);
		} finally {
			cap.restore();
		}
	});

	it("strips the suffix and warns when the adapter flag says routing is unsupported", async () => {
		const request = post({
			model: 'z-ai/glm-4.5-air:free {"sort":"price"}',
			messages: [],
		});
		const account = { id: "o", provider: "openai-compatible" } as Account;
		const cap = captureWarnings();
		try {
			const result = await transformRequestBodyModel(
				request,
				account,
				undefined,
				{
					providerRouting: false,
					supportsProviderRouting: () => false,
				},
			);
			const body = await result.json();
			expect(body.model).toBe("z-ai/glm-4.5-air:free");
			expect("provider" in body).toBe(false);
			expect(cap.warnings.length).toBe(1);
		} finally {
			cap.restore();
		}
	});

	it("lets the adapter hook declare routing support for a non-listed provider", async () => {
		const request = post({
			model: 'z-ai/glm-4.5-air:free {"sort":"price"}',
			messages: [],
		});
		const account = { id: "o", provider: "openai-compatible" } as Account;
		const result = await transformRequestBodyModel(
			request,
			account,
			undefined,
			{
				supportsProviderRouting: () => true,
			},
		);
		const body = await result.json();
		expect(body.model).toBe("z-ai/glm-4.5-air:free");
		expect(body.provider).toEqual({ sort: "price" });
	});

	it("forwards optional routing on a provider ccflare does not know either way", async () => {
		const request = post({
			model: 'z-ai/glm-4.5-air:free {"sort":"price"}',
			messages: [],
		});
		const account = { id: "o", provider: "openai-compatible" } as Account;
		const cap = captureWarnings();
		try {
			const result = await transformRequestBodyModel(request, account);
			const body = await result.json();
			expect(body.provider).toEqual({ sort: "price" });
			expect(cap.warnings).toEqual([]);
		} finally {
			cap.restore();
		}
	});

	it("sets body.provider for a provider-specific mapper on a routing provider", async () => {
		const request = post({
			model: 'claude-haiku {"only":["deepseek"]}',
			messages: [],
		});
		const result = await transformRequestBodyModel(
			request,
			openrouterAccount(),
			(model) => `mapped-${model}`,
		);
		const body = await result.json();
		expect(body.model).toBe("mapped-claude-haiku");
		expect(body.provider).toEqual({ only: ["deepseek"] });
	});

	it("lets the explicit suffix win over a body provider field", async () => {
		const request = post({
			model: 'm {"only":["a"]}',
			provider: { ignore: ["stdin"] },
			messages: [],
		});
		const result = await transformRequestBodyModel(
			request,
			openrouterAccount(),
		);
		const body = await result.json();
		expect(body.provider).toEqual({ only: ["a"] });
	});

	it("keeps the body's own provider field when it already matches the suffix", async () => {
		const request = post({
			model: 'm {"only":["a"]}',
			provider: { only: ["a"] },
		});
		const result = await transformRequestBodyModel(
			request,
			openrouterAccount(),
		);
		const body = await result.json();
		expect(body.model).toBe("m");
		// The applied routing is identical to what the client already sent, so
		// the body needs no rewrite at all.
		expect(body.provider).toEqual({ only: ["a"] });
	});

	it("returns the original request when there is no routing (no provider added)", async () => {
		const request = post({ model: "z-ai/glm-4.5-air:free", messages: [] });
		const result = await transformRequestBodyModel(
			request,
			openrouterAccount(),
		);
		expect(result).toBe(request);
	});

	it("strips the suffix on a provider that rejects routing and drops the caller's provider field", async () => {
		const request = post({
			model: 'claude-x {"only":["a"]}',
			provider: { only: ["b"] },
			messages: [],
		});
		const account = { id: "a", provider: "anthropic" } as Account;
		const cap = captureWarnings();
		try {
			const result = await transformRequestBodyModel(request, account);
			const body = await result.json();
			expect(body.model).toBe("claude-x");
			// The suffix took control of routing; the client's pin must not ride
			// along to a provider that rejects routing anyway.
			expect("provider" in body).toBe(false);
			expect(cap.warnings.length).toBe(1);
		} finally {
			cap.restore();
		}
	});

	it("leaves a malformed suffix in the model verbatim", async () => {
		const request = post({ model: "foo {bad json", messages: [] });
		const result = await transformRequestBodyModel(
			request,
			openrouterAccount(),
		);
		expect(result).toBe(request);
		const body = await result.json();
		expect(body.model).toBe("foo {bad json");
	});
});

describe("transformRequestBodyModel — the client's provider field never rides along", () => {
	function post(body: unknown): Request {
		return new Request("http://test.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function captureWarnings(): { warnings: string[]; restore: () => void } {
		const warnings: string[] = [];
		const listener = (event: { level: string; msg: string }) => {
			if (event.level === "WARN") warnings.push(event.msg);
		};
		logBus.on("log", listener);
		return { warnings, restore: () => logBus.off("log", listener) };
	}

	it("drops the client's provider when the mapping suffix sanitises to nothing", async () => {
		const request = post({
			model: "claude-sonnet-4-5-20250929",
			provider: { only: ["client-pin"] },
			messages: [],
		});
		const account = {
			id: "o",
			provider: "openrouter",
			model_mappings: JSON.stringify({
				"claude-sonnet-4-5-20250929": "a/b {}",
			}),
		} as Account;
		const result = await transformRequestBodyModel(request, account);
		expect(result).not.toBe(request);
		const body = await result.json();
		expect(body.model).toBe("a/b");
		expect("provider" in body).toBe(false);
	});

	it("drops the client's provider when the mapped name equals the original and the provider cannot route", async () => {
		const request = post({
			model: 'claude-sonnet-4-5-20250929 {"only":["a"]}',
			provider: { only: ["client-pin"] },
			messages: [],
		});
		const account = { id: "a", provider: "anthropic" } as Account;
		const cap = captureWarnings();
		try {
			const result = await transformRequestBodyModel(request, account);
			expect(result).not.toBe(request);
			const body = await result.json();
			expect(body.model).toBe("claude-sonnet-4-5-20250929");
			expect("provider" in body).toBe(false);
			expect(cap.warnings.length).toBe(1);
		} finally {
			cap.restore();
		}
	});

	it("drops the client's provider when the mapping value itself names an unrouteable suffix", async () => {
		const request = post({
			model: "claude-sonnet-4-5-20250929",
			provider: { only: ["client-pin"] },
			messages: [],
		});
		const account = {
			id: "a",
			provider: "anthropic",
			model_mappings: JSON.stringify({
				"claude-sonnet-4-5-20250929": 'some/model {"only":["a"]}',
			}),
		} as Account;
		const cap = captureWarnings();
		try {
			const result = await transformRequestBodyModel(request, account);
			const body = await result.json();
			expect(body.model).toBe("some/model");
			expect("provider" in body).toBe(false);
		} finally {
			cap.restore();
		}
	});

	it("leaves a body with no routing suffix and no mapping untouched, provider included", async () => {
		const request = post({
			model: "claude-sonnet-4-5-20250929",
			provider: { only: ["client-pin"] },
			messages: [],
		});
		const account = { id: "o", provider: "anthropic" } as Account;
		const result = await transformRequestBodyModel(request, account);
		expect(result).toBe(request);
	});

	it("drops the client's provider when force account model is on and the provider rejects routing", async () => {
		const { setForceAccountModel } = await import("@better-ccflare/core");
		setForceAccountModel(true);
		const cap = captureWarnings();
		try {
			const request = post({
				model: 'claude-sonnet-4-5-20250929 {"only":["a"]}',
				provider: { only: ["client-pin"] },
				messages: [],
			});
			const account = { id: "a", provider: "anthropic" } as Account;
			const result = await transformRequestBodyModel(request, account);
			const body = await result.json();
			expect(body.model).toBe("claude-sonnet-4-5-20250929");
			expect("provider" in body).toBe(false);
		} finally {
			setForceAccountModel(false);
			cap.restore();
		}
	});

	it("forwards the request suffix as before when force account model is on and the provider routes", async () => {
		const { setForceAccountModel } = await import("@better-ccflare/core");
		setForceAccountModel(true);
		try {
			const request = post({
				model: 'claude-sonnet-4-5-20250929 {"only":["a"]}',
				messages: [],
			});
			const account = {
				id: "o",
				provider: "openrouter",
				model_mappings: JSON.stringify({
					"claude-sonnet-4-5-20250929": "mapped",
				}),
			} as Account;
			const result = await transformRequestBodyModel(request, account);
			const body = await result.json();
			// Force account model: no mapping rename, routing still applies.
			expect(body.model).toBe("claude-sonnet-4-5-20250929");
			expect(body.provider).toEqual({ only: ["a"] });
		} finally {
			setForceAccountModel(false);
		}
	});

	it("forwards routing for a NanoGPT account on its default host", async () => {
		const { NanoGPTProvider } = await import(
			"../../providers/nanogpt/provider"
		);
		const provider = new NanoGPTProvider();
		const account = { id: "n", provider: "nanogpt" } as Account;
		const request = post({
			model: 'z-ai/glm-4.5-air:free {"sort":"price"}',
			messages: [],
		});
		const result = await provider.transformRequestBody(request, account);
		const body = await result.json();
		expect(body.model).toBe("z-ai/glm-4.5-air:free");
		expect(body.provider).toEqual({ sort: "price" });
	});

	it("strips and warns for a NanoGPT account pointed at a custom endpoint", async () => {
		const { NanoGPTProvider } = await import(
			"../../providers/nanogpt/provider"
		);
		const provider = new NanoGPTProvider();
		const account = {
			id: "n",
			provider: "nanogpt",
			custom_endpoint: "https://third-party.example/api",
		} as Account;
		const cap = captureWarnings();
		try {
			const request = post({
				model: 'z-ai/glm-4.5-air:free {"sort":"price"}',
				messages: [],
			});
			const result = await provider.transformRequestBody(request, account);
			const body = await result.json();
			expect(body.model).toBe("z-ai/glm-4.5-air:free");
			expect("provider" in body).toBe(false);
			expect(cap.warnings.length).toBe(1);
		} finally {
			cap.restore();
		}
	});

	it("forwards routing for OpenRouter unchanged", async () => {
		const request = post({
			model: 'z-ai/glm-4.5-air:free {"sort":"price"}',
			messages: [],
		});
		const account = {
			id: "o",
			provider: "openrouter",
			custom_endpoint: "https://openrouter.ai/api/v1",
		} as Account;
		const result = await transformRequestBodyModel(request, account);
		const body = await result.json();
		expect(body.provider).toEqual({ sort: "price" });
	});
});
