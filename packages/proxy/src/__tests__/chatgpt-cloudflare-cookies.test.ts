import { describe, expect, it } from "bun:test";
import {
	ChatGptCloudflareCookieJar,
	isAllowedChatGptHost,
} from "../chatgpt-cloudflare-cookies";

function makeSetCookieResponse(setCookies: string[]): Response {
	return new Response(null, {
		headers: setCookies.map(
			(value) => ["set-cookie", value] as [string, string],
		),
	});
}

function cookieParts(headers: Headers): string[] {
	const cookie = headers.get("Cookie");
	if (!cookie) return [];
	return cookie.split("; ").sort();
}

describe("ChatGptCloudflareCookieJar", () => {
	it("stores and replays only allowlisted Cloudflare cookie names for chatgpt.com", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"__cflb=west; Path=/; Secure; HttpOnly",
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
			"cf_clearance=clearance; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(cookieParts(headers)).toEqual(
			["__cflb=west", "_cfuvid=visitor", "cf_clearance=clearance"].sort(),
		);
	});

	it("ignores cookies set for non-chatgpt hosts", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse("https://api.openai.com/v1/responses", response);

		const headers = new Headers();
		jar.applyCookieHeader("https://api.openai.com/v1/responses", headers);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("ignores non-cloudflare cookies for chatgpt.com hosts", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"__Secure-next-auth.session-token=secret; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("ignores mixed cloudflare and non-cloudflare cookies, keeping only cloudflare ones", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
			"chatgpt_session=secret; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBe("_cfuvid=visitor");
	});

	it("never leaks chatgpt.com cookies to a different host", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader("https://api.openai.com/v1/responses", headers);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("rejects plain http chatgpt.com urls", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"http://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const httpHeaders = new Headers();
		jar.applyCookieHeader(
			"http://chatgpt.com/backend-api/codex/responses",
			httpHeaders,
		);
		expect(httpHeaders.get("Cookie")).toBeNull();

		const httpsHeaders = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			httpsHeaders,
		);
		expect(httpsHeaders.get("Cookie")).toBeNull();
	});

	it("replaces __cflb value on load-balancer affinity switch", () => {
		const jar = new ChatGptCloudflareCookieJar();

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(["__cflb=west; Path=/; Secure; HttpOnly"]),
		);
		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(["__cflb=central; Path=/; Secure; HttpOnly"]),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBe("__cflb=central");
	});
});

describe("isAllowedChatGptHost", () => {
	it("allows chatgpt.com and its recognized subdomains/aliases", () => {
		for (const host of [
			"chatgpt.com",
			"foo.chatgpt.com",
			"staging.chatgpt.com",
			"chat.openai.com",
			"chatgpt-staging.com",
			"api.chatgpt-staging.com",
		]) {
			expect(isAllowedChatGptHost(host)).toBe(true);
		}
	});

	it("rejects lookalike and unrelated hosts", () => {
		for (const host of [
			"evilchatgpt.com",
			"chatgpt.com.evil.example",
			"api.openai.com",
			"foo.chat.openai.com",
		]) {
			expect(isAllowedChatGptHost(host)).toBe(false);
		}
	});
});
