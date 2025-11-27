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
