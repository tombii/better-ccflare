import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeProxyRequest } from "../request-handler";

/**
 * Regression for tombii#336 / Greptile P1 "Probe Secret Reaches Provider Path":
 * the internal probe secret (and the marker headers it gates) must be stripped
 * before the request is forwarded upstream, so a provider or custom endpoint
 * never receives the process-local capability secret.
 */
describe("makeProxyRequest strips internal control headers before provider forward", () => {
	let realFetch: typeof globalThis.fetch;
	let sentHeaders: Headers | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		sentHeaders = undefined;
		globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
			sentHeaders =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("ok", { status: 200 });
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("does not forward the probe secret or markers on the headers-param path", async () => {
		const headers = new Headers({
			"x-better-ccflare-internal-probe-secret": "s3cr3t",
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-keepalive": "true",
			authorization: "Bearer token",
			"content-type": "application/json",
		});
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(
			sentHeaders?.get("x-better-ccflare-internal-probe-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-auto-refresh")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		// unrelated headers still forwarded
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("does not forward the probe secret on the Request-target path", async () => {
		const req = new Request("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-better-ccflare-internal-probe-secret": "s3cr3t",
				"x-better-ccflare-keepalive": "true",
				authorization: "Bearer token",
			},
		});
		await makeProxyRequest(req);
		expect(
			sentHeaders?.get("x-better-ccflare-internal-probe-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});
});
