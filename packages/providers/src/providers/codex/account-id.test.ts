import { describe, expect, it } from "bun:test";
import { extractChatgptAccountId } from "./account-id";

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(payload: unknown): string {
	return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("extractChatgptAccountId", () => {
	it("reads chatgpt_account_id from the OpenAI auth claim", () => {
		const token = jwt({
			sub: "user-1",
			"https://api.openai.com/auth": {
				chatgpt_account_id: "acct_123",
				chatgpt_plan_type: "plus",
			},
		});

		expect(extractChatgptAccountId(token)).toBe("acct_123");
	});

	it("returns null when the auth claim is missing", () => {
		expect(extractChatgptAccountId(jwt({ sub: "user-1" }))).toBeNull();
	});

	it("returns null when the id is empty or not a string", () => {
		expect(
			extractChatgptAccountId(
				jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "  " } }),
			),
		).toBeNull();
		expect(
			extractChatgptAccountId(
				jwt({ "https://api.openai.com/auth": { chatgpt_account_id: 42 } }),
			),
		).toBeNull();
	});

	it("returns null for a string that is not a JWT", () => {
		expect(extractChatgptAccountId("not-a-jwt")).toBeNull();
		expect(extractChatgptAccountId("")).toBeNull();
	});

	it("returns null when the payload segment is not JSON", () => {
		expect(extractChatgptAccountId("aGVhZGVy.###.sig")).toBeNull();
		expect(
			extractChatgptAccountId(
				`aGVhZGVy.${Buffer.from("plain text").toString("base64url")}.sig`,
			),
		).toBeNull();
	});

	it("returns null for null and undefined", () => {
		expect(extractChatgptAccountId(null)).toBeNull();
		expect(extractChatgptAccountId(undefined)).toBeNull();
	});
});
