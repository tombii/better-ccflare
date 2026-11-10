import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API } from "../api";

// biome-ignore lint/suspicious/noExplicitAny: exercising a private static helper
const redact = (value: unknown) => (API as any).redactForLog(value);

describe("API.redactForLog", () => {
	it("redacts an apiKey from an account-add body", () => {
		const out = redact({
			name: "sail",
			apiKey: "sk-live-secret",
			priority: 3,
		});
		expect(out).toEqual({ name: "sail", apiKey: "[REDACTED]", priority: 3 });
	});

	it("redacts every casing and spelling of credential fields", () => {
		const out = redact({
			apiKey: "a",
			api_key: "b",
			token: "c",
			accessToken: "d",
			access_token: "e",
			refreshToken: "f",
			refresh_token: "g",
			secret: "h",
			password: "i",
			code: "j",
			authorization: "k",
		}) as Record<string, string>;
		for (const value of Object.values(out)) {
			expect(value).toBe("[REDACTED]");
		}
	});

	it("redacts nested credentials but keeps non-secret fields", () => {
		const out = redact({
			name: "acct",
			modelMappings: { "claude-sonnet-5-5": "gpt-6" },
			auth: { apiKey: "sk-nested", region: "eu" },
		});
		expect(out).toEqual({
			name: "acct",
			modelMappings: { "claude-sonnet-5-5": "gpt-6" },
			auth: { apiKey: "[REDACTED]", region: "eu" },
		});
	});

	it("redacts credentials inside arrays", () => {
		expect(redact([{ apiKey: "x" }, { name: "y" }])).toEqual([
			{ apiKey: "[REDACTED]" },
			{ name: "y" },
		]);
	});

	it("does not match keys that merely contain a secret word", () => {
		expect(redact({ codex: "keep", encoded: "keep", tokenCount: 5 })).toEqual({
			codex: "keep",
			encoded: "keep",
			tokenCount: 5,
		});
	});

	it("passes primitives and null through unchanged", () => {
		expect(redact("plain")).toBe("plain");
		expect(redact(42)).toBe(42);
		expect(redact(null)).toBeNull();
		expect(redact(undefined)).toBeUndefined();
	});
});

describe("api.ts request logging", () => {
	const source = readFileSync(join(import.meta.dir, "..", "api.ts"), "utf8");

	// Any outgoing body must be redacted before it reaches console.debug. This
	// catches a new add<Provider>Account-style method that logs `{ data }` raw.
	it("never logs an unredacted request body", () => {
		const offenders = source
			.split("\n")
			.map((line, i) => ({ line: line.trim(), number: i + 1 }))
			.filter(({ line }) => {
				if (!/logger\.debug\(`→ (POST|PATCH|PUT) /.test(line)) return false;
				// text after the template literal — i.e. what is actually logged
				const logged = line.split("`")[2] ?? "";
				if (logged.includes("redactForLog")) return false;
				// whole-body variables must go through the redactor; small
				// explicit field logs ({ endpoint }, { accountId }, ...) are fine
				return /\b(data|body|payload|partial|settings)\s*[,}]/.test(logged);
			});
		expect(offenders).toEqual([]);
	});
});
