/**
 * OpenAI's OAuth access and id tokens are JWTs whose payload carries a
 * `https://api.openai.com/auth` claim with the ChatGPT account id. The Codex
 * CLI forwards that id as the `ChatGPT-Account-Id` header on every backend
 * call (`codex-rs/backend-client/src/client.rs`, `fn headers`), and the usage
 * endpoint expects it.
 *
 * The signature is deliberately NOT verified: the value is only echoed back
 * to its issuer as a request header, never used for authorization here.
 */
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export function extractChatgptAccountId(
	token: string | null | undefined,
): string | null {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length < 2 || parts[1] === "") return null;

	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (typeof payload !== "object" || payload === null) return null;

	const auth = (payload as Record<string, unknown>)[OPENAI_AUTH_CLAIM];
	if (typeof auth !== "object" || auth === null) return null;

	const id = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof id === "string" && id.trim() !== "" ? id : null;
}
