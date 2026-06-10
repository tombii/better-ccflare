import type { Account } from "@better-ccflare/types";

const API_KEY_ONLY_PROVIDERS = new Set([
	"openai-compatible",
	"zai",
	"claude-console-api",
	"anthropic-compatible",
	"minimax",
]);

/**
 * OAuth accounts whose upstream 401 may indicate a stale access token rather
 * than permanently invalid credentials.
 */
export function canAttemptStaleTokenRefresh(account: Account): boolean {
	if (!account.refresh_token) {
		return false;
	}
	if (API_KEY_ONLY_PROVIDERS.has(account.provider)) {
		return false;
	}
	if (account.api_key && !account.access_token) {
		return false;
	}
	return true;
}

export function isStaleAuthResponseStatus(status: number): boolean {
	return status === 401;
}
