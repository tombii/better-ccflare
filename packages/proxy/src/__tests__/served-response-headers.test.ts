import { describe, expect, it } from "bun:test";
import {
	SERVED_ACCOUNT_HEADER,
	SERVED_MODEL_HEADER,
} from "@better-ccflare/core";
import { withServedResponseHeaders } from "../response-handler";

function responseWith(
	headers: Record<string, string> = {},
	body: BodyInit | null = "ok",
): Response {
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/plain", ...headers },
	});
}

describe("withServedResponseHeaders", () => {
	it("sets an ASCII account name and model verbatim", () => {
		const response = withServedResponseHeaders(
			responseWith(),
			"main-account",
			"claude-sonnet-4-6",
		);

		expect(response.headers.get(SERVED_ACCOUNT_HEADER)).toBe("main-account");
		expect(response.headers.get(SERVED_MODEL_HEADER)).toBe("claude-sonnet-4-6");
	});

	it("percent-encodes a non-ASCII account name so Headers.get stays ASCII", () => {
		const response = withServedResponseHeaders(
			responseWith(),
			"café",
			"model-1",
		);

		expect(response.headers.get(SERVED_ACCOUNT_HEADER)).toBe("caf%C3%A9");
		for (const char of response.headers.get(SERVED_ACCOUNT_HEADER) ?? "") {
			const code = char.charCodeAt(0);
			expect(code).toBeGreaterThanOrEqual(0x20);
			expect(code).toBeLessThanOrEqual(0x7e);
		}
	});

	it("does not throw on a lone surrogate and yields a valid header value", () => {
		// A client-controlled model id (`POST /v1/messages {"model":"\ud800"}`)
		// reaches this header. encodeURIComponent throws URIError on a lone
		// surrogate, which used to escape as a 500.
		const response = withServedResponseHeaders(
			responseWith(),
			"account",
			"m\ud800del",
		);

		const value = response.headers.get(SERVED_MODEL_HEADER);
		expect(value).not.toBeNull();
		for (const char of value ?? "") {
			const code = char.charCodeAt(0);
			expect(code).toBeGreaterThanOrEqual(0x20);
			expect(code).toBeLessThanOrEqual(0x7e);
		}
		// U+FFFD's UTF-8 bytes are EF BF BD; the surrounding literal bytes stay.
		expect(value).toBe("m%EF%BF%BDdel");
	});

	it("deletes a pre-existing model header when servedModel is null", () => {
		const response = withServedResponseHeaders(
			responseWith({ [SERVED_MODEL_HEADER]: "stale" }),
			"account",
			null,
		);

		expect(response.headers.get(SERVED_MODEL_HEADER)).toBeNull();
		expect(response.headers.get(SERVED_ACCOUNT_HEADER)).toBe("account");
	});

	it("overwrites upstream-supplied copies of both headers", () => {
		const response = withServedResponseHeaders(
			responseWith({
				[SERVED_ACCOUNT_HEADER]: "upstream-account",
				[SERVED_MODEL_HEADER]: "upstream-model",
			}),
			"local-account",
			"local-model",
		);

		expect(response.headers.get(SERVED_ACCOUNT_HEADER)).toBe("local-account");
		expect(response.headers.get(SERVED_MODEL_HEADER)).toBe("local-model");
	});
});
