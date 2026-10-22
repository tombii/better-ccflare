/**
 * The Qoder provider tags its requests with two internal headers:
 *
 *   - `x-better-ccflare-qoder-model` — the wire model key it actually sent
 *     (the upstream echoes "auto", so the proxy has to copy the tag back onto
 *     the response for the provider to attribute the answer);
 *   - `x-better-ccflare-qoder-request-id` — the request's own uuid, carried
 *     across a replay so the re-signed envelope keeps the body's id.
 *
 * Both are internal signals: they must never reach the upstream.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { makeProxyRequest } from "../handlers/request-handler";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("internal Qoder headers never reach the upstream", () => {
	it("strips the model tag and the request id from the upstream request", async () => {
		let seen: Headers | null = null;
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			seen = new Headers(init?.headers ?? (init as RequestInit)?.headers);
			return new Response("ok", { status: 200 });
		}) as unknown as typeof fetch;

		await makeProxyRequest(
			new Request("https://api3.qoder.sh/algo/api/v2/model/list", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-qoder-model": "qfmodel",
					"x-better-ccflare-qoder-request-id":
						"11111111-2222-3333-4444-555555555555",
					"x-better-ccflare-request-stream": "true",
				},
			}),
		);

		const headers = seen as unknown as Headers;
		expect(headers.get("x-better-ccflare-qoder-model")).toBeNull();
		expect(headers.get("x-better-ccflare-qoder-request-id")).toBeNull();
		expect(headers.get("x-better-ccflare-request-stream")).toBeNull();
	});
});
