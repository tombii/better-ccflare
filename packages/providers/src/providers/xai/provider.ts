import { getEndpointUrl, validateEndpointUrl } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import type { TokenRefreshResult } from "../../types";
import { OpenAICompatibleProvider } from "../openai/provider";

const log = new Logger("XaiProvider");

export const XAI_DEFAULT_ENDPOINT = "https://api.x.ai/v1";
export const XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
export const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export const XAI_MODEL_MAPPINGS = {
	opus: "grok-4.3",
	sonnet: "grok-4.3",
	haiku: "grok-4.3",
	fable: "grok-4.3",
};

export class XaiProvider extends OpenAICompatibleProvider {
	override name = "xai";

	override async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(`No xAI refresh token for account ${account.name}`);
		}

		log.info(`Refreshing xAI token for account ${account.name}`);

		const body = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: XAI_DEFAULT_CLIENT_ID,
			refresh_token: account.refresh_token,
		});

		const response = await fetch(XAI_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!response.ok) {
			let message = response.statusText;
			try {
				const data = (await response.json()) as {
					error?: string;
					error_description?: string;
				};
				// Preserve the machine-readable OAuth error code (e.g. "invalid_grant")
				// ahead of the human description so the token-manager's requires_reauth
				// detection can classify a dead xAI refresh token.
				message =
					[data.error, data.error_description].filter(Boolean).join(": ") ||
					message;
			} catch {
				// Do not include raw response bodies in refresh errors; auth servers
				// should not echo credentials, but keeping messages structured avoids
				// accidental token exposure if that ever changes.
			}
			throw new Error(
				`Failed to refresh xAI token for account ${account.name}: ${response.status} ${message}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};

		if (!json.access_token) {
			throw new Error(
				`xAI refresh response for account ${account.name} did not include an access token`,
			);
		}

		const expiresInSeconds =
			typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
				? json.expires_in
				: 6 * 60 * 60;

		return {
			accessToken: json.access_token,
			refreshToken: json.refresh_token || account.refresh_token,
			expiresAt: Date.now() + expiresInSeconds * 1000,
		};
	}

	override buildUrl(path: string, query: string, account?: Account): string {
		let endpoint = XAI_DEFAULT_ENDPOINT;
		try {
			endpoint = account?.custom_endpoint
				? getEndpointUrl(account)
				: XAI_DEFAULT_ENDPOINT;
			endpoint = validateEndpointUrl(endpoint, "xAI endpoint");
		} catch (error) {
			log.warn(
				`Invalid xAI endpoint for ${account?.name ?? "unknown"}; using default`,
				error,
			);
		}

		let openaiPath = path === "/v1/messages" ? "/v1/chat/completions" : path;
		if (endpoint.endsWith("/v1") && openaiPath.startsWith("/v1/")) {
			openaiPath = openaiPath.replace(/^\/v1/, "");
		}
		return `${endpoint}${openaiPath}${query}`;
	}

	override supportsOAuth(): boolean {
		return true;
	}

	override supportsUsageTracking(): boolean {
		return true;
	}

	override beforeConvert(
		_body: Record<string, unknown>,
		account?: Account,
	): Account | undefined {
		if (!account) return account;
		return {
			...account,
			custom_endpoint: account.custom_endpoint ?? XAI_DEFAULT_ENDPOINT,
			model_mappings:
				account.model_mappings ?? JSON.stringify(XAI_MODEL_MAPPINGS),
		};
	}

	override afterConvert(body: OpenAIRequest): void {
		// Ask OpenAI-compatible streaming APIs to include a final usage chunk when
		// supported. xAI accepts this OpenAI field and it improves request accounting
		// when the downstream client streams responses.
		if (body.stream) {
			const record = body as unknown as Record<string, unknown>;
			record.stream_options = {
				...(typeof record.stream_options === "object" && record.stream_options
					? (record.stream_options as Record<string, unknown>)
					: {}),
				include_usage: true,
			};
		}
	}
}
