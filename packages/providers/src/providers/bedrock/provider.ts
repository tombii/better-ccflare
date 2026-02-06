import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { Provider, TokenRefreshResult, RateLimitInfo } from "../../types";
import {
	createBedrockCredentialChain,
	parseBedrockConfig,
	translateBedrockError,
} from "./index";

const log = new Logger("BedrockProvider");

/**
 * AWS Bedrock provider for better-ccflare
 *
 * Integrates with better-ccflare's provider system to route /v1/messages requests
 * to AWS Bedrock accounts. Uses Phase 1 utilities for credential management and
 * AWS SDK v3 for automatic SigV4 signing.
 *
 * Architecture:
 * - Credentials resolved per-request from ~/.aws/credentials (no database storage)
 * - Profile and region stored in custom_endpoint field (format: "bedrock:profile:region")
 * - AWS SDK BedrockRuntimeClient handles SigV4 signing automatically
 * - Stub methods for Phases 3-5 (model translation, response handling, token extraction)
 *
 * Phase progression:
 * - Phase 2 (current): Provider registration and credential validation
 * - Phase 3: Request transformation (model translation, BedrockRuntimeClient)
 * - Phase 4: Response handling (streaming, error mapping)
 * - Phase 5: Token extraction and usage tracking
 */
export class BedrockProvider extends BaseProvider implements Provider {
	name = "bedrock";

	/**
	 * Check if this provider can handle the given request path
	 *
	 * Currently only supports Anthropic Messages API compatibility (/v1/messages).
	 * Future phases may add support for other endpoints.
	 *
	 * User decision (CONTEXT.md): Return true even if account config is invalid.
	 * Error surfaces at request time, not during routing.
	 *
	 * @param path - Request path (e.g., "/v1/messages")
	 * @returns true if this provider can handle the path
	 */
	canHandle(path: string): boolean {
		// Only handle /v1/messages for now (Anthropic Messages API compatibility)
		return path.startsWith("/v1/messages");
	}

	/**
	 * Refresh/validate AWS credentials for a Bedrock account
	 *
	 * Bedrock uses AWS credentials (not OAuth tokens), so this method validates
	 * that credentials exist and are accessible via the AWS credential chain.
	 *
	 * Resolution order (AWS SDK standard):
	 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
	 * 2. AWS profiles from ~/.aws/credentials (using specified profile)
	 * 3. IAM role via instance metadata (when running on EC2/ECS)
	 *
	 * Returns a long-lived dummy token (1 year) since credentials are read from
	 * ~/.aws/credentials per-request, not cached in database.
	 *
	 * @param account - Account with custom_endpoint format "bedrock:profile:region"
	 * @param _clientId - Unused (Bedrock doesn't use OAuth)
	 * @returns TokenRefreshResult with dummy token indicating credentials are valid
	 * @throws Error if credentials are invalid or profile is misconfigured
	 */
	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// Parse profile and region from custom_endpoint ("bedrock:profile:region")
		const config = parseBedrockConfig(account.custom_endpoint);

		if (!config) {
			throw new Error(
				`Invalid Bedrock config for account ${account.name}: expected format "bedrock:profile:region"`,
			);
		}

		// Validate credentials exist by creating credential chain
		// This fails early if profile is misconfigured
		try {
			const credentialProvider = createBedrockCredentialChain(account);
			// Attempt to resolve credentials to validate they exist
			await credentialProvider();
			log.info(
				`Bedrock credentials valid for account ${account.name} (profile: ${config.profile}, region: ${config.region})`,
			);
		} catch (error) {
			const errorMsg = translateBedrockError(error);
			throw new Error(
				`Bedrock credential validation failed for ${account.name}: ${errorMsg}`,
			);
		}

		// Return dummy token (Bedrock doesn't use tokens, credentials are resolved per-request)
		// Use long expiry since credentials are read from ~/.aws/credentials per-request
		return {
			accessToken: "bedrock-credentials-valid",
			expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
			refreshToken: "", // Empty string prevents DB update
		};
	}

	/**
	 * Build target URL for Bedrock request
	 *
	 * Bedrock uses AWS SDK client (not HTTP URLs), so this returns a placeholder.
	 * Actual requests in Phase 3 use BedrockRuntimeClient.invokeModel(), not fetch().
	 *
	 * @param path - Request path (e.g., "/v1/messages")
	 * @param query - Query string (e.g., "?foo=bar")
	 * @param account - Account configuration (for name logging)
	 * @returns Placeholder URL for logging/debugging
	 */
	buildUrl(path: string, query: string, account?: Account): string {
		// Bedrock uses AWS SDK client (not HTTP URLs)
		// Return placeholder - actual requests use BedrockRuntimeClient in Phase 3
		return `bedrock://${account?.name || "unknown"}${path}${query}`;
	}

	/**
	 * Prepare headers for Bedrock request
	 *
	 * Bedrock uses AWS SigV4 signing (not HTTP headers like Authorization or x-api-key).
	 * Phase 1 AWS SDK handles signing automatically via BedrockRuntimeClient.
	 *
	 * Remove client's authorization headers to prevent conflicts with AWS signing.
	 *
	 * @param headers - Original request headers
	 * @param _accessToken - Unused (Bedrock uses AWS credentials, not tokens)
	 * @param _apiKey - Unused (Bedrock uses AWS credentials, not API keys)
	 * @returns Cleaned headers with authorization removed
	 */
	prepareHeaders(
		headers: Headers,
		_accessToken?: string,
		_apiKey?: string,
	): Headers {
		// Bedrock uses AWS SigV4 signing (not headers)
		// Phase 1 AWS SDK handles signing automatically
		// Remove client's authorization headers to prevent conflicts
		const newHeaders = new Headers(headers);
		newHeaders.delete("authorization");
		newHeaders.delete("x-api-key");
		newHeaders.delete("host");
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");
		return newHeaders;
	}

	/**
	 * Parse rate limit information from Bedrock response
	 *
	 * AWS Bedrock throttling is handled via error codes (ThrottlingException),
	 * not via HTTP headers like Anthropic (anthropic-ratelimit-*).
	 *
	 * Stub for now - Phase 4 implements throttling detection from error codes.
	 *
	 * @param response - Bedrock response
	 * @returns Rate limit info (stub implementation)
	 */
	parseRateLimit(response: Response): RateLimitInfo {
		// AWS Bedrock throttling handled via error codes (ThrottlingException)
		// Not via HTTP headers like Anthropic
		// Stub for now - Phase 4 implements throttling detection
		if (response.status === 429) {
			return { isRateLimited: true };
		}
		return { isRateLimited: false };
	}

	/**
	 * Process Bedrock response before returning to client
	 *
	 * Stub for now - Phase 4 implements response transformation:
	 * - Error code mapping (ThrottlingException → 429)
	 * - Streaming event parsing (SSE format)
	 * - Usage token extraction
	 *
	 * @param response - Bedrock response
	 * @param _account - Account configuration (for logging)
	 * @returns Processed response (stub implementation)
	 */
	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		// Stub - Phase 4 implements response transformation
		return response;
	}

	/**
	 * Transform request body before sending to Bedrock
	 *
	 * Stub for now - Phase 3 implements:
	 * - Model name translation (e.g., "claude-3-5-sonnet-20241022" → "us.anthropic.claude-3-5-sonnet-20241022-v2:0")
	 * - Request body transformation (Messages API → Bedrock InvokeModel format)
	 *
	 * @param request - Original request
	 * @param _account - Account configuration (for region/profile)
	 * @returns Transformed request (stub implementation)
	 */
	async transformRequestBody(
		request: Request,
		_account?: Account,
	): Promise<Request> {
		// Stub - Phase 3 implements model translation
		return request;
	}

	/**
	 * Extract usage information from Bedrock response
	 *
	 * Stub for now - Phase 5 implements token extraction from Bedrock responses:
	 * - Parse usage block from response JSON
	 * - Calculate costs based on model pricing
	 * - Track cache usage (if Bedrock supports prompt caching)
	 *
	 * @param _response - Bedrock response
	 * @returns Usage information (stub implementation)
	 */
	async extractUsageInfo(_response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		inputTokens?: number;
		outputTokens?: number;
	} | null> {
		// Stub - Phase 5 implements token extraction from Bedrock responses
		return null;
	}

	/**
	 * Check if Bedrock response is streaming
	 *
	 * Stub for now - Phase 3 implements streaming detection:
	 * - Bedrock uses SSE (Server-Sent Events) format
	 * - Check for text/event-stream content type
	 *
	 * @param response - Bedrock response
	 * @returns true if response is streaming (stub implementation)
	 */
	isStreamingResponse(response: Response): boolean {
		// Stub - Phase 3 implements streaming detection
		const contentType = response.headers.get("content-type") || "";
		return (
			contentType.includes("text/event-stream") ||
			contentType.includes("stream")
		);
	}
}
