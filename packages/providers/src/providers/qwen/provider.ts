import { getEndpointUrl, validateEndpointUrl } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
import { OpenAICompatibleProvider } from "../openai/provider";
import { refreshQwenTokens } from "./device-oauth";

const log = new Logger("QwenProvider");

const DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_USER_AGENT = "QwenCode/0.14.2 (darwin; arm64)";

// All Anthropic model tiers map to coder-model (Qwen's unified coding model)
const QWEN_MODEL_MAPPINGS = {
	opus: "coder-model",
	sonnet: "coder-model",
	haiku: "coder-model",
};

export class QwenProvider extends OpenAICompatibleProvider {
	override name = "qwen";

	override async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(`No refresh token available for account ${account.name}`);
		}

		const result = await refreshQwenTokens(account.refresh_token);

		return {
			accessToken: result.accessToken,
			expiresAt: Date.now() + result.expiresIn * 1000,
			refreshToken: result.refreshToken,
		};
	}

	override buildUrl(path: string, query: string, account?: Account): string {
		let endpoint: string;
		try {
			endpoint = account ? getEndpointUrl(account) : DEFAULT_ENDPOINT;
			endpoint = validateEndpointUrl(endpoint, "endpoint");
		} catch (error) {
			log.error(
				`Invalid endpoint for account ${account?.name || "unknown"}, using default: ${error instanceof Error ? error.message : String(error)}`,
			);
			endpoint = DEFAULT_ENDPOINT;
		}

		// Convert Anthropic paths to OpenAI-compatible paths (inherited logic)
		let openaiPath = this.convertAnthropicPathToOpenAI(path);
		if (endpoint.endsWith("/v1") && openaiPath.startsWith("/v1/")) {
			openaiPath = openaiPath.replace(/^\/v1/, "");
		}

		return `${endpoint}${openaiPath}${query}`;
	}

	override prepareHeaders(
		_headers: Headers,
		accessToken?: string,
		_apiKey?: string,
	): Headers {
		// Start from a clean set — DashScope is sensitive to unexpected headers
		// (e.g. x-stainless-*, anthropic-*, accept-encoding) causing 429s.
		const newHeaders = new Headers();

		// Set Qwen auth headers
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		}

		// Qwen/DashScope SDK headers (verified against qwen-code repo)
		newHeaders.set("Content-Type", "application/json");
		newHeaders.set("User-Agent", QWEN_USER_AGENT);
		newHeaders.set("X-DashScope-CacheControl", "enable");
		newHeaders.set("X-DashScope-UserAgent", QWEN_USER_AGENT);
		newHeaders.set("X-DashScope-AuthType", "qwen-oauth");

		return newHeaders;
	}

	/**
	 * Override request body transformation to inject Qwen-specific fields:
	 * - Convert system message to array format with cache_control
	 * - Add vl_high_resolution_images for vision support
	 * - Add stream_options for streaming
	 */
	override async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const contentType = request.headers.get("content-type");

		if (!contentType?.includes("application/json")) {
			return request;
		}

		try {
			const body = await request.json();
			// Apply Qwen default model mappings if the account has no custom mappings
			const effectiveAccount = account
				? {
						...account,
						model_mappings:
							account.model_mappings ?? JSON.stringify(QWEN_MODEL_MAPPINGS),
					}
				: account;
			const openaiBody = this.convertAnthropicRequestToOpenAI(
				body,
				effectiveAccount,
			);

			const bodyAsRecord = openaiBody as unknown as Record<string, unknown>;

			// Inject Qwen system message with cache_control (DashScope requirement)
			this.injectQwenSystemMessage(bodyAsRecord);

			// Add vision support flag (coder-model supports vision)
			bodyAsRecord.vl_high_resolution_images = true;

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(openaiBody),
			});
		} catch (error) {
			log.error("Failed to transform request for Qwen:", error);
			return request;
		}
	}

	override parseRateLimit(_response: Response): RateLimitInfo {
		// Qwen handles its own rate limiting — never mark as rate-limited
		// Quota errors come as 403s and are handled inline by the API
		return {
			isRateLimited: false,
			statusHeader: "allowed",
		};
	}

	override supportsOAuth(): boolean {
		return true;
	}

	override supportsUsageTracking(): boolean {
		return true;
	}

	/**
	 * Convert system message to array format with cache_control as required by DashScope.
	 *
	 * Qwen requires strict message ordering. System messages must use content array format:
	 * { role: "system", content: [{ type: "text", text: "...", cache_control: { type: "ephemeral" } }] }
	 */
	private injectQwenSystemMessage(body: Record<string, unknown>): void {
		const messages = body.messages as Array<{
			role: string;
			content:
				| string
				| Array<{
						type: string;
						text?: string;
						cache_control?: { type: string };
				  }>;
		}>;

		if (!Array.isArray(messages)) return;

		for (const msg of messages) {
			if (msg.role === "system" && typeof msg.content === "string") {
				msg.content = [
					{
						type: "text",
						text: msg.content,
						cache_control: { type: "ephemeral" },
					},
				];
			}
		}
	}
}
