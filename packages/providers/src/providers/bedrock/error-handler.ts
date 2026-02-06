import {
	DatabaseFactory,
	ModelTranslationRepository,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockErrorHandler");

/**
 * Translate AWS SDK Bedrock errors to user-friendly messages with HTTP status codes
 *
 * This function catches AWS Bedrock errors (credential, throttling, service errors)
 * and converts them to actionable messages with appropriate HTTP status codes
 * for automatic failover.
 *
 * BREAKING CHANGE (Phase 4): Return type changed from string to { statusCode, message }
 * to support error response construction with proper HTTP status codes.
 *
 * Note: AWS SDK (@aws-sdk/client-bedrock-runtime) handles SigV4 signing automatically,
 * including payload transformation, canonical request generation, and signature calculation.
 * This utility only translates errors when signing fails (e.g., bad credentials).
 *
 * Error name normalization: Handles both PascalCase (non-streaming) and camelCase (streaming)
 * error names from Bedrock API (e.g., "ThrottlingException" vs "throttlingException").
 *
 * @param error - Error from AWS SDK (thrown by BedrockRuntimeClient)
 * @returns Object with statusCode and user-friendly message (never throws)
 *
 * Example usage:
 * ```typescript
 * try {
 *   const response = await client.send(command);
 * } catch (error) {
 *   const { statusCode, message } = translateBedrockError(error);
 *   return new Response(JSON.stringify({ error: message }), { status: statusCode });
 * }
 * ```
 */
export function translateBedrockError(error: unknown): {
	statusCode: number;
	message: string;
} {
	const errorName = (error as { name?: string }).name;
	const errorMessage = (error as { message?: string }).message;
	const requestId = (error as { requestId?: string }).requestId || "unknown";

	// Normalize error name to lowercase for case-insensitive matching
	const normalizedName = errorName?.toLowerCase() || "";

	// Credential/Auth errors → 403
	if (
		normalizedName.includes("invalidaccesskeyid") ||
		normalizedName.includes("signaturedonotmatch") ||
		normalizedName.includes("expiredtoken") ||
		normalizedName.includes("invalidclienttokenid") ||
		normalizedName.includes("unrecognizedclientexception")
	) {
		log.warn(`Credential error: ${errorName}`);
		return {
			statusCode: 403,
			message:
				"AWS credentials invalid. Check ~/.aws/credentials or use AWS CLI to configure credentials.",
		};
	}

	// Throttling → 429
	if (normalizedName.includes("throttling")) {
		log.warn(`Throttling error: ${errorName}`);
		return {
			statusCode: 429,
			message: `ThrottlingException: Rate exceeded. Request ID: ${requestId}. Failing over to next provider.`,
		};
	}

	// Service errors → 503
	if (
		normalizedName.includes("serviceunavailable") ||
		normalizedName.includes("internalserver")
	) {
		log.warn(`Service error: ${errorName}`);
		return {
			statusCode: 503,
			message:
				"Bedrock service unavailable. Check AWS status page. Failing over to next provider.",
		};
	}

	// Model not found → 404
	if (normalizedName.includes("resourcenotfound")) {
		log.warn(`Model not found: ${errorName}`);
		const suggestion = getModelNotFoundSuggestion(error);
		return {
			statusCode: 404,
			message: `ResourceNotFoundException: ${errorMessage || "Model not found"}. ${suggestion}Failing over to next provider.`,
		};
	}

	// Validation errors → 400
	if (normalizedName.includes("validation")) {
		log.warn(`Validation error: ${errorName}`);
		return {
			statusCode: 400,
			message: `${errorMessage || "Validation error"}. Failing over to next provider.`,
		};
	}

	// Fallback for unknown errors → 500
	log.error(`Unknown Bedrock error: ${errorName} - ${errorMessage}`);
	return {
		statusCode: 500,
		message: `AWS error: ${errorName || "Unknown"}. Failing over to next provider.`,
	};
}

/**
 * Get model suggestions for "Did you mean?" when model is not found
 * Extracts model name from error message and finds similar models in database
 * @param error - AWS error object
 * @returns Suggestion string or empty string if no suggestions
 */
function getModelNotFoundSuggestion(error: unknown): string {
	const errorMessage = (error as { message?: string }).message || "";

	// Try to extract model name from error message
	// Common patterns: "Model 'claude-3-5-sonnet' not found" or "models arn:aws:bedrock:us-east-1::foundation-model/..."
	const modelPatterns = [
		/model['"]\s*[:=]?\s*['"]([^'"]+)['"]/i,
		/foundation-model\/([a-z0-9.-]+)/i,
		/model\s+([a-z0-9.-]+)/i,
	];

	let modelName: string | undefined;
	for (const pattern of modelPatterns) {
		const match = errorMessage.match(pattern);
		if (match?.[1]) {
			modelName = match[1];
			break;
		}
	}

	if (!modelName) {
		return "";
	}

	try {
		const db = DatabaseFactory.getInstance();
		const repo = new ModelTranslationRepository(db.getDatabase());
		const suggestions = repo.findSimilar(modelName, 3);

		if (suggestions.length > 0) {
			const suggestedNames = suggestions.map((s) => s.client_name).join(", ");
			return `Did you mean: ${suggestedNames}? `;
		}
	} catch (err) {
		log.warn(`Failed to get model suggestions: ${(err as Error).message}`);
	}

	return "";
}
