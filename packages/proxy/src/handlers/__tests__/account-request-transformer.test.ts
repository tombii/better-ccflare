import { describe, expect, it } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { Account, LogEvent } from "@better-ccflare/types";
import { applyAccountRequestTransformer } from "../account-request-transformer";

const TRANSFORMER = "max-tokens-to-max-completion-tokens" as const;

function account(requestTransformer: Account["request_transformer"]): Account {
	return { request_transformer: requestTransformer } as Account;
}

function jsonRequest(body: unknown, init: RequestInit = {}): Request {
	return new Request("https://upstream.example/v1/chat/completions?trace=1", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		...init,
	});
}

async function jsonOf(request: Request): Promise<unknown> {
	return request.clone().json();
}

describe("applyAccountRequestTransformer", () => {
	it("renames max_tokens to max_completion_tokens", async () => {
		const transformed = await applyAccountRequestTransformer(
			jsonRequest({ model: "o1", max_tokens: 321 }),
			account(TRANSFORMER),
		);

		expect(await jsonOf(transformed)).toEqual({
			model: "o1",
			max_completion_tokens: 321,
		});
	});

	it("preserves an explicit max_completion_tokens value", async () => {
		const transformed = await applyAccountRequestTransformer(
			jsonRequest({ max_tokens: 321, max_completion_tokens: 99 }),
			account(TRANSFORMER),
		);

		expect(await jsonOf(transformed)).toEqual({
			max_completion_tokens: 99,
		});
	});

	it("preserves an explicit falsy max_completion_tokens value", async () => {
		const transformed = await applyAccountRequestTransformer(
			jsonRequest({ max_tokens: 321, max_completion_tokens: 0 }),
			account(TRANSFORMER),
		);

		expect(await jsonOf(transformed)).toEqual({
			max_completion_tokens: 0,
		});
	});

	it("returns the original request when max_tokens is absent", async () => {
		const request = jsonRequest({ model: "o1", temperature: 0 });

		expect(
			await applyAccountRequestTransformer(request, account(TRANSFORMER)),
		).toBe(request);
	});

	it("returns the original request when the transformer is disabled", async () => {
		const request = jsonRequest({ model: "o1", max_tokens: 321 });

		expect(await applyAccountRequestTransformer(request, account(null))).toBe(
			request,
		);
	});

	it("returns the original request for non-JSON content", async () => {
		const request = new Request("https://upstream.example/v1/completions", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "max_tokens=321",
		});

		expect(
			await applyAccountRequestTransformer(request, account(TRANSFORMER)),
		).toBe(request);
	});

	for (const [name, body] of [
		["malformed JSON", "{"],
		["an array JSON body", "[321]"],
		["a null JSON body", "null"],
	] as const) {
		it(`returns the original request for ${name}`, async () => {
			const request = new Request("https://upstream.example/v1/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});

			expect(
				await applyAccountRequestTransformer(request, account(TRANSFORMER)),
			).toBe(request);
		});
	}

	it("preserves request metadata and removes stale content-length when rebuilding", async () => {
		const controller = new AbortController();
		const request = jsonRequest(
			{ model: "o1", max_tokens: 321 },
			{
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-length": "999",
					"x-request-marker": "keep-me",
				},
				signal: controller.signal,
			},
		);

		const transformed = await applyAccountRequestTransformer(
			request,
			account(TRANSFORMER),
		);

		expect(transformed.url).toBe(request.url);
		expect(transformed.method).toBe(request.method);
		expect(transformed.headers.get("content-type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(transformed.headers.get("x-request-marker")).toBe("keep-me");
		expect(transformed.headers.has("content-length")).toBe(false);
		expect(transformed.signal).toBe(request.signal);
	});

	it("warns and returns the original request for an unknown persisted ID", async () => {
		const request = jsonRequest({ model: "o1", max_tokens: 321 });
		const events: LogEvent[] = [];
		const capture = (event: LogEvent) => events.push(event);
		logBus.on("log", capture);

		try {
			expect(
				await applyAccountRequestTransformer(
					request,
					account("removed-transformer" as Account["request_transformer"]),
				),
			).toBe(request);
		} finally {
			logBus.off("log", capture);
		}

		expect(events).toContainEqual({
			ts: expect.any(Number),
			level: "WARN",
			msg: "Unknown account request transformer; request left unchanged",
			data: { requestTransformer: "removed-transformer" },
		});
	});
});
