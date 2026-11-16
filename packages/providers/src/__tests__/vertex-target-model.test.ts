import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { VertexAIProvider } from "../providers/vertex-ai/provider";
import type { ProviderRequestState } from "../types";

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

async function prepare(
	provider: VertexAIProvider,
	request: Request,
	account: Account,
): Promise<ProviderRequestState> {
	return (await provider.prepareRequest(
		request,
		await request.clone().arrayBuffer(),
		account,
	)) as ProviderRequestState;
}

/**
 * Vertex addresses the model in the URL and removes body.model, so the proxy
 * cannot read the served model off the outgoing body. getTargetModel is the
 * provider's answer to "which model did buildUrl just put in the URL", for one
 * attempt's state.
 */
describe("VertexAIProvider.getTargetModel", () => {
	it("returns the mapped, Vertex-formatted model prepareRequest chose", async () => {
		const provider = new VertexAIProvider();
		const account = vertexAccount({
			model_mappings: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
		});
		const request = messagesRequest("claude-sonnet-4-6");
		const state = await prepare(provider, request, account);

		const target = provider.getTargetModel(account, state);
		expect(target).toBeTruthy();
		expect(target).toContain("haiku");
		expect(target).not.toContain("sonnet");
		// The same model buildUrl puts in the request path.
		expect(provider.buildUrl("/v1/messages", "", account, state)).toContain(
			`/models/${target}:`,
		);
	});

	it("is undefined when no prepareRequest state is supplied", () => {
		expect(
			new VertexAIProvider().getTargetModel(vertexAccount()),
		).toBeUndefined();
	});
});

describe("VertexAIProvider per-request model state", () => {
	it("keeps two concurrent requests on one account from reading each other's model", async () => {
		const provider = new VertexAIProvider();
		const account = vertexAccount({
			model_mappings: JSON.stringify({
				sonnet: "claude-haiku-4-5",
				opus: "claude-opus-4-6",
			}),
		});
		const requestA = messagesRequest("claude-sonnet-4-6");
		const requestB = messagesRequest("claude-opus-4-6");

		// A prepares, then B prepares on the SAME account object before A is
		// dispatched — the interleaving that used to overwrite A's model.
		const stateA = await prepare(provider, requestA, account);
		const stateB = await prepare(provider, requestB, account);

		expect(provider.getTargetModel(account, stateA)).toContain("haiku");
		expect(provider.getTargetModel(account, stateB)).toContain("opus");
		expect(provider.getTargetModel(account, stateA)).not.toContain("opus");
		expect(provider.buildUrl("/v1/messages", "", account, stateA)).toContain(
			"/models/claude-haiku-4-5:",
		);
		expect(provider.buildUrl("/v1/messages", "", account, stateB)).toContain(
			"/models/claude-opus-4-6:",
		);
	});

	it("leaves the account object unmutated", async () => {
		const provider = new VertexAIProvider();
		const account = vertexAccount({
			model_mappings: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
		});
		const request = messagesRequest("claude-sonnet-4-6");
		const state = await prepare(provider, request, account);

		provider.buildUrl("/v1/messages", "", account, state);
		await provider.transformRequestBody(request, account);

		expect(Object.hasOwn(account, "_vertexModel")).toBe(false);
		expect(Object.hasOwn(account, "_originalModel")).toBe(false);
		expect("_vertexModel" in account).toBe(false);
		expect("_originalModel" in account).toBe(false);
	});
});

describe("VertexAIProvider.processResponse model restoration", () => {
	it("restores the client's model from the per-request state", async () => {
		const provider = new VertexAIProvider();
		const account = vertexAccount();
		const request = messagesRequest("claude-sonnet-4-6");
		const state = await prepare(provider, request, account);

		const upstream = new Response(
			JSON.stringify({ model: state.vertexModel, content: [] }),
			{ headers: { "content-type": "application/json" } },
		);
		const processed = await provider.processResponse(
			upstream,
			account,
			undefined,
			undefined,
			{ providerState: state },
		);
		const body = (await processed.json()) as { model?: string };
		expect(body.model).toBe("claude-sonnet-4-6");
	});

	it("passes the response through untouched when there is no state", async () => {
		const provider = new VertexAIProvider();
		const upstream = new Response(
			JSON.stringify({ model: "claude-sonnet-4-6@20250929", content: [] }),
			{ headers: { "content-type": "application/json" } },
		);
		const processed = await provider.processResponse(upstream, vertexAccount());
		const body = (await processed.json()) as { model?: string };
		expect(body.model).toBe("claude-sonnet-4-6@20250929");
	});
});
