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
			"x-better-ccflare-request-id": "internal-request-id",
			"x-better-ccflare-request-stream": "true",
			"x-better-ccflare-codex-custom-tools": "true",
			"x-better-ccflare-native-responses": "true",
			"x-better-ccflare-exclude-providers": "anthropic-oauth",
			"x-lanetally-codex-continuation": "previous_response_id",
			"x-lanetally-prompt-cache-mode": "implicit",
			"x-lanetally-prompt-cache-ttl": "30m",
			"x-lanetally-prompt-cache-breakpoint": "developer",
			"x-lanetally-codex-path": "native_responses",
			"x-lanetally-codex-transport": "sse",
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
		expect(sentHeaders?.get("x-better-ccflare-request-id")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-stream")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-codex-custom-tools")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-native-responses")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-exclude-providers")).toBeNull();
		for (const header of [
			"x-lanetally-codex-continuation",
			"x-lanetally-prompt-cache-mode",
			"x-lanetally-prompt-cache-ttl",
			"x-lanetally-prompt-cache-breakpoint",
			"x-lanetally-codex-path",
			"x-lanetally-codex-transport",
		]) {
			expect(sentHeaders?.get(header)).toBeNull();
		}
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
				"x-better-ccflare-request-id": "internal-request-id",
				"x-better-ccflare-native-responses": "true",
				"x-better-ccflare-exclude-providers": "anthropic-oauth",
				"x-lanetally-codex-continuation": "previous_response_id",
				"x-lanetally-prompt-cache-mode": "implicit",
				"x-lanetally-prompt-cache-ttl": "30m",
				"x-lanetally-prompt-cache-breakpoint": "developer",
				"x-lanetally-codex-path": "native_responses",
				"x-lanetally-codex-transport": "sse",
				authorization: "Bearer token",
			},
		});
		await makeProxyRequest(req);
		expect(
			sentHeaders?.get("x-better-ccflare-internal-probe-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-id")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-native-responses")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-exclude-providers")).toBeNull();
		for (const header of [
			"x-lanetally-codex-continuation",
			"x-lanetally-prompt-cache-mode",
			"x-lanetally-prompt-cache-ttl",
			"x-lanetally-prompt-cache-breakpoint",
			"x-lanetally-codex-path",
			"x-lanetally-codex-transport",
		]) {
			expect(sentHeaders?.get(header)).toBeNull();
		}
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});
});
