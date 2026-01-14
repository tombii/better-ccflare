import { TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { GoogleAuth } from "google-auth-library";
import type { TokenRefreshResult } from "../../types";
import {
	type AnthropicCompatibleConfig,
	BaseAnthropicCompatibleProvider,
} from "../base-anthropic-compatible";

const log = new Logger("VertexAIProvider");

// Vertex AI configuration stored in custom_endpoint field
export interface VertexAIConfig {
	projectId: string;
	region: string;
}

export class VertexAIProvider extends BaseAnthropicCompatibleProvider {
	private auth: GoogleAuth;

	constructor(config?: Partial<AnthropicCompatibleConfig>) {
		super({
			name: "vertex-ai",
			authType: "bearer",
			authHeader: "authorization",
			supportsStreaming: true,
			...config,
		});

		// GoogleAuth automatically discovers credentials from:
		// 1. GOOGLE_APPLICATION_CREDENTIALS env var
		// 2. gcloud auth application-default login file (~/.config/gcloud/application_default_credentials.json)
		// 3. Attached service account (when running on GCP)
		this.auth = new GoogleAuth({
			scopes: "https://www.googleapis.com/auth/cloud-platform",
		});
	}

	getEndpoint(): string {
		// This is the base endpoint, but actual URL is built in buildUrl()
		return "https://aiplatform.googleapis.com";
	}

	/**
	 * Parse Vertex AI configuration from custom_endpoint field
	 */
	private parseVertexConfig(account: Account): VertexAIConfig {
		if (!account.custom_endpoint) {
			throw new Error(
				`Account ${account.name} is missing Vertex AI configuration (project ID and region)`,
			);
		}

		try {
			const config = JSON.parse(account.custom_endpoint) as VertexAIConfig;
			if (!config.projectId || !config.region) {
				throw new Error("Invalid Vertex AI configuration");
			}
			return config;
		} catch (error) {
			throw new Error(
				`Failed to parse Vertex AI configuration for account ${account.name}: ${error}`,
			);
		}
	}

	/**
	 * Refresh access token using google-auth-library
	 * Tokens are automatically refreshed and valid for 1 hour
	 */
	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		try {
			const client = await this.auth.getClient();
			const accessTokenResponse = await client.getAccessToken();

			if (!accessTokenResponse.token) {
				throw new Error("Failed to obtain access token from Google Auth");
			}

			log.info(
				`Successfully refreshed Vertex AI access token for account ${account.name}`,
			);

			return {
				accessToken: accessTokenResponse.token,
				// Google Cloud access tokens expire after 1 hour
				expiresAt: Date.now() + TIME_CONSTANTS.GOOGLE_TOKEN_EXPIRY_MS,
				refreshToken: "", // Empty to prevent DB update
			};
		} catch (error) {
			log.error(
				`Failed to refresh Vertex AI token for account ${account.name}:`,
				error,
			);
			throw new Error(
				`Failed to authenticate with Google Cloud: ${error}. ` +
					"Ensure you've run 'gcloud auth application-default login' or set GOOGLE_APPLICATION_CREDENTIALS.",
			);
		}
	}

	/**
	 * Build Vertex AI URL with model in path
	 * Format: https://{region}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{region}/publishers/anthropic/models/{model}:streamRawPredict
	 */
	buildUrl(path: string, query: string, account?: Account): string {
		if (!account) {
			throw new Error("Account is required for Vertex AI provider");
		}

		const config = this.parseVertexConfig(account);

		// Get model from temporary storage (set in transformRequestBody)
		const model =
			(account as Account & { _vertexModel?: string })._vertexModel ||
			"claude-sonnet-4-5@20250929";

		// Determine if streaming based on path
		const isStreaming =
			path.includes("stream") || query.includes("stream=true");
		const specifier = isStreaming ? "streamRawPredict" : "rawPredict";

		// Build base URL - use global endpoint for 'global' region
		const baseUrl =
			config.region === "global"
				? "https://aiplatform.googleapis.com"
				: `https://${config.region}-aiplatform.googleapis.com`;

		// Build full Vertex AI URL with model in path
		return `${baseUrl}/v1/projects/${config.projectId}/locations/${config.region}/publishers/anthropic/models/${model}:${specifier}`;
	}

	/**
	 * Transform request body for Vertex AI:
	 * 1. Extract model from body (it goes in URL instead)
	 * 2. Add anthropic_version field to body
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		try {
			const body = await request.json();

			// Extract and remove model from body
			const model = body.model;
			delete body.model;

			// Add Vertex-specific version field (must be in body, not header)
			body.anthropic_version = "vertex-2023-10-16";

			// Temporarily store model for buildUrl
			// This is a workaround since buildUrl is called after transformRequestBody
			if (account && model) {
				(account as Account & { _vertexModel?: string })._vertexModel = model;
			}

			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
			});
		} catch (error) {
			log.error("Failed to transform request body for Vertex AI:", error);
			throw error;
		}
	}

	/**
	 * Vertex AI doesn't support OAuth
	 */
	supportsOAuth(): boolean {
		return false;
	}

	/**
	 * Override prepareHeaders to remove anthropic-beta header
	 * Vertex AI doesn't support this header and will reject requests with it
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		// Call parent to get base headers with authorization
		const preparedHeaders = super.prepareHeaders(headers, accessToken, apiKey);

		// Remove anthropic-beta header if present (Vertex AI doesn't support it)
		preparedHeaders.delete("anthropic-beta");

		// Remove anthropic-version header if present (Vertex AI requires it in body, not header)
		preparedHeaders.delete("anthropic-version");

		return preparedHeaders;
	}
}
