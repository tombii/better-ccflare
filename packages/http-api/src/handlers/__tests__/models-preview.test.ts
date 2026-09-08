import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createModelsPreviewHandler } from "../models";

/**
 * `POST /api/models/preview` answers the same question as the `accountId`
 * branch of `GET /api/models` — which models can this endpoint serve — but
 * for the account wizard, before an account row exists to read api_key /
 * custom_endpoint from. It takes the raw apiKey/endpoint the user just typed
 * instead of an accountId.
 */

const LIVE_BODY = {
	data: [{ id: "gpt-oss-120b" }, { id: "gpt-oss-20b" }],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(body: unknown): Request {
	return new Request("http://local/api/models/preview", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/models/preview", () => {
	it("returns the live listing for a valid apiKey/endpoint", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const handler = createModelsPreviewHandler();
		const response = await handler(
			request({
				apiKey: "sk-test-1234567890",
				endpoint: "https://api.example.com/v1",
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			provider: string;
			models: Array<{ id: string; displayName: string; source: string }>;
			source: string;
			fetchedAt: number;
		};
		expect(body.provider).toBe("openai-compatible");
		expect(body.source).toBe("preview");
		expect(body.models).toEqual([
			{ id: "gpt-oss-120b", displayName: "gpt-oss-120b", source: "preview" },
			{ id: "gpt-oss-20b", displayName: "gpt-oss-20b", source: "preview" },
		]);
		expect(body.fetchedAt).toBeGreaterThan(0);
	});

	it("rejects a missing apiKey with 400", async () => {
		const handler = createModelsPreviewHandler();
		const response = await handler(
			request({ endpoint: "https://api.example.com/v1" }),
		);

		expect(response.status).toBe(400);
	});

	it("rejects a missing endpoint with 400", async () => {
		const handler = createModelsPreviewHandler();
		const response = await handler(request({ apiKey: "sk-test-1234567890" }));

		expect(response.status).toBe(400);
	});

	it("rejects a non-string apiKey with 400", async () => {
		const handler = createModelsPreviewHandler();
		const response = await handler(
			request({ apiKey: 12345, endpoint: "https://api.example.com/v1" }),
		);

		expect(response.status).toBe(400);
	});

	// The wizard has no cache to fall back to, so a failed underlying fetch
	// must surface as an error response rather than degrading silently.
	it("returns a non-200 error response when the endpoint rejects the credentials, and never echoes the apiKey", async () => {
		const secretApiKey = "sk-super-secret-should-not-leak";
		globalThis.fetch = (async () =>
			new Response("unauthorized", {
				status: 401,
			})) as typeof globalThis.fetch;

		const handler = createModelsPreviewHandler();
		const response = await handler(
			request({
				apiKey: secretApiKey,
				endpoint: "https://api.example.com/v1",
			}),
		);

		expect(response.status).not.toBe(200);
		const text = await response.text();
		expect(text).not.toContain(secretApiKey);
	});

	it("returns a non-200 error response when the endpoint is unreachable, and never echoes the apiKey", async () => {
		const secretApiKey = "sk-another-secret-value";
		globalThis.fetch = (async () => {
			throw new Error("fetch failed: network error");
		}) as typeof globalThis.fetch;

		const handler = createModelsPreviewHandler();
		const response = await handler(
			request({
				apiKey: secretApiKey,
				endpoint: "https://api.example.com/v1",
			}),
		);

		expect(response.status).not.toBe(200);
		const text = await response.text();
		expect(text).not.toContain(secretApiKey);
	});

	it("rejects an invalid JSON body with 400", async () => {
		const handler = createModelsPreviewHandler();
		const response = await handler(
			new Request("http://local/api/models/preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "not json",
			}),
		);

		expect(response.status).toBe(400);
	});
});
