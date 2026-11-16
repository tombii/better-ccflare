import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { VertexAIProvider } from "../providers/vertex-ai/provider";

function vertexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-vertex",
		name: "vertex",
		provider: "vertex-ai",
		custom_endpoint: JSON.stringify({ projectId: "p", region: "global" }),
		model_mappings: null,
		...overrides,
	} as unknown as Account;
}

function messagesRequest(model: string): Request {
	return new Request("http://localhost/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
		}),
	});
}

/**
 * Vertex addresses the model in the URL and removes body.model, so the proxy
 * cannot read the served model off the outgoing body. getTargetModel is the
 * provider's answer to "which model did buildUrl just put in the URL".
 */
describe("VertexAIProvider.getTargetModel", () => {
	it("returns the mapped, Vertex-formatted model prepareRequest chose", async () => {
		const provider = new VertexAIProvider();
		const account = vertexAccount({
			model_mappings: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
		});
		const request = messagesRequest("claude-sonnet-4-6");
		provider.prepareRequest(
			request,
			await request.clone().arrayBuffer(),
			account,
		);

		const target = provider.getTargetModel(account);
		expect(target).toBeTruthy();
		expect(target).toContain("haiku");
		expect(target).not.toContain("sonnet");
		// The same model buildUrl puts in the request path.
		expect(provider.buildUrl("/v1/messages", "", account)).toContain(
			`/models/${target}:`,
		);
	});

	it("is undefined when prepareRequest never ran for the account", () => {
		expect(
			new VertexAIProvider().getTargetModel(vertexAccount()),
		).toBeUndefined();
	});
});
