import { TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { GoogleAuth } from "google-auth-library";
import type { TokenRefreshResult } from "../../types";
import { getModelName } from "../../utils/model-mapping";
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

/**
 * Convert Anthropic model format to Vertex AI format
 * Anthropic: claude-haiku-4-5-20251001
 * Vertex AI: claude-haiku-4-5@20251001
 *
 * @param anthropicModel - Model name in Anthropic format
 * @returns Model name in Vertex AI format (with @ before date)
 */
function convertToVertexAIModel(anthropicModel: string): string {
	// Match pattern: claude-{family}-{version}-{date}
	// Replace the last hyphen before the 8-digit date with @
	const vertexModel = anthropicModel.replace(/-(\d{8})$/, "@$1");

	if (vertexModel !== anthropicModel) {
		console.log(
			`[Vertex AI] Converted Anthropic model to Vertex AI format: ${anthropicModel} -> ${vertexModel}`,
		);
	}

	return vertexModel;
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

			console.log(
				`[Vertex AI] Successfully refreshed access token for account ${account.name}`,
			);

			return {
				accessToken: accessTokenResponse.token,
				// Google Cloud access tokens expire after 1 hour
				expiresAt: Date.now() + TIME_CONSTANTS.GOOGLE_TOKEN_EXPIRY_MS,
				refreshToken: "", // Empty to prevent DB update
			};
		} catch (error) {
			console.log(
				`[Vertex AI] Failed to refresh token for account ${account.name}:`,
				error,
			);
			throw new Error(
				`Failed to authenticate with Google Cloud: ${error}. ` +
					"Ensure you've run 'gcloud auth application-default login' or set GOOGLE_APPLICATION_CREDENTIALS.",
			);
		}
	}

	/**
	 * Pre-process request to extract model information
	 * This is called before buildUrl to ensure the model is available
	 */
	prepareRequest(
		_request: Request,
		requestBodyBuffer: ArrayBuffer | null,
		account: Account,
	): void {
		try {
			if (!requestBodyBuffer) {
				console.log("[Vertex AI] No request body, using fallback model");
				return;
			}

			// Extract model from request body
			const bodyText = new TextDecoder().decode(requestBodyBuffer);
			const body = JSON.parse(bodyText);
			const originalModel = body.model || "claude-sonnet-4-5-20250929";

			console.log(
				`[Vertex AI] prepareRequest - extracted model: ${originalModel}`,
			);

			// Apply custom model mappings if configured
			let transformedModel = originalModel;
			if (account?.model_mappings) {
				transformedModel = getModelName(originalModel, account);
				console.log(
					`[Vertex AI] prepareRequest - after mapping: ${transformedModel}`,
				);
			}

			// Convert to Vertex AI format
			const vertexModel = convertToVertexAIModel(transformedModel);
			console.log(`[Vertex AI] prepareRequest - Vertex format: ${vertexModel}`);

			// Store models in account for buildUrl to use
			(
				account as Account & {
					_vertexModel?: string;
					_originalModel?: string;
				}
			)._vertexModel = vertexModel;
			(
				account as Account & {
					_vertexModel?: string;
					_originalModel?: string;
				}
			)._originalModel = originalModel;
		} catch (error) {
			console.log(
				"[Vertex AI] prepareRequest - failed to extract model:",
				error,
			);
		}
	}

	/**
	 * Build Vertex AI URL with model in path
	 * Format: https://{region}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{region}/publishers/anthropic/models/{model}:streamRawPredict
	 *
	 * Note: buildUrl is called BEFORE transformRequestBody in the proxy flow,
	 * so we use a cached model from the account object (set by transformRequestBody on previous calls)
	 */
	buildUrl(path: string, query: string, account?: Account): string {
		if (!account) {
			throw new Error("Account is required for Vertex AI provider");
		}

		const config = this.parseVertexConfig(account);

		// Get model from temporary storage (set in transformRequestBody)
		// Fallback to sonnet in Vertex AI format if not set
		const model =
			(account as Account & { _vertexModel?: string })._vertexModel ||
			"claude-sonnet-4-5@20250929";

		console.log(`[Vertex AI] buildUrl called - using model: ${model}`);

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
		const fullUrl = `${baseUrl}/v1/projects/${config.projectId}/locations/${config.region}/publishers/anthropic/models/${model}:${specifier}`;

		console.log(`[Vertex AI] Full Vertex AI URL: ${fullUrl}`);

		return fullUrl;
	}

	/**
	 * Transform request body for Vertex AI:
	 * 1. Remove model from body (it goes in URL instead, already extracted by prepareRequest)
	 * 2. Add anthropic_version field to body
	 *
	 * Note: prepareRequest is called before this to extract and store the model
	 */
	async transformRequestBody(
		request: Request,
		_account?: Account,
	): Promise<Request> {
		try {
			const body = await request.json();

			console.log(
				`[Vertex AI] transformRequestBody - removing model from body`,
			);

			// Remove model from body (Vertex AI requires it in URL, not body)
			delete body.model;

			// Add Vertex-specific version field (must be in body, not header)
			body.anthropic_version = "vertex-2023-10-16";

			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
			});
		} catch (error) {
			console.log("[Vertex AI] Failed to transform request body:", error);
			throw error;
		}
	}

	/**
	 * Override processResponse to restore original model name in response
	 * This ensures history records the Anthropic model format, not Vertex AI format
	 */
	async processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response> {
		const originalModel = (account as Account & { _originalModel?: string })
			?._originalModel;

		console.log(
			`[Vertex AI] processResponse - originalModel stored: ${originalModel}`,
		);

		// If no original model stored, return response as-is
		if (!originalModel) {
			console.log(
				"[Vertex AI] No original model stored, returning response as-is",
			);
			return super.processResponse(response, account);
		}

		try {
			// Clone response to read body
			const clonedResponse = response.clone();
			const contentType = response.headers.get("content-type") || "";

			console.log(`[Vertex AI] Response content-type: ${contentType}`);

			// Only process JSON responses
			if (!contentType.includes("application/json")) {
				console.log(
					"[Vertex AI] Not JSON response, skipping model restoration",
				);
				return super.processResponse(response, account);
			}

			const text = await clonedResponse.text();
			const data = JSON.parse(text);

			console.log(`[Vertex AI] Response model from Vertex AI: ${data.model}`);

			// Replace Vertex AI model format with original Anthropic format
			if (data.model) {
				data.model = originalModel;
				console.log(
					`[Vertex AI] Restored original model in response: ${data.model}`,
				);
			}

			// Create new response with updated body
			const newResponse = new Response(JSON.stringify(data), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});

			return super.processResponse(newResponse, account);
		} catch (error) {
			// If anything fails, return original response
			console.log(
				"[Vertex AI] Failed to restore original model in response:",
				error,
			);
			return super.processResponse(response, account);
		}
	}

	/**
	 * Vertex AI doesn't support OAuth
	 */
	supportsOAuth(): boolean {
		return false;
	}

	/**
	 * Override canHandle to block unsupported endpoints
	 * Vertex AI only supports Anthropic API endpoints, not telemetry endpoints
	 */
	canHandle(path: string): boolean {
		// Block Claude Code internal telemetry endpoint
		// This endpoint doesn't exist on Vertex AI and causes "messages: Field required" errors
		if (path === "/api/event_logging/batch") {
			return false;
		}
		// Allow all other paths (v1/messages, v1/complete, etc.)
		return true;
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
