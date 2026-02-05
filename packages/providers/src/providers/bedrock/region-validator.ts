import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Provider } from "@smithy/types";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockRegionValidator");

/**
 * Validate that Bedrock service is available in the specified region
 * Makes a lightweight API call to test service availability and credentials
 *
 * Note: This makes a minimal test request (InvokeModel with tiny payload).
 * Even if the specific model is not available, successful authentication
 * indicates the region and credentials are valid.
 *
 * @param region - AWS region to validate (e.g., "us-east-1", "eu-west-1")
 * @param credentials - AWS credential provider function
 * @returns true if region is valid and credentials work, false otherwise
 *
 * Example usage:
 * ```typescript
 * const credentials = fromEnv();
 * const isValid = await validateBedrockRegion("us-east-1", credentials);
 * if (!isValid) {
 *   console.error("Bedrock is not available in us-east-1");
 * }
 * ```
 */
export async function validateBedrockRegion(
	region: string,
	credentials: Provider<any>,
): Promise<boolean> {
	try {
		const client = new BedrockRuntimeClient({ region, credentials });

		// Make a minimal InvokeModel request to test service availability
		// Use a well-known model ID (anthropic.claude-3-5-sonnet-20241022-v2:0)
		// This will validate both region and credentials
		const command = new InvokeModelCommand({
			modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			contentType: "application/json",
			accept: "application/json",
			body: JSON.stringify({
				anthropic_version: "vertex-2023-05-23",
				max_tokens: 1,
				messages: [{ role: "user", content: "" }],
			}),
		});

		await client.send(command);

		log.info(`Region ${region} validated: Bedrock service is available`);
		return true;
	} catch (error: unknown) {
		// Check for specific error types
		const errorName = (error as { name?: string }).name;
		const errorMessage = (error as { message?: string }).message;

		// ValidationException or ResourceNotFoundException means credentials work
		// but the request format might be wrong or model not found
		// This is still considered "valid" for credential purposes
		if (
			errorName === "ValidationException" ||
			errorName === "ResourceNotFoundException"
		) {
			log.warn(
				`Region ${region} returned ${errorName} - credentials are valid but request may need adjustment`,
			);
			return true;
		}

		// AccessDeniedException or UnauthorizedOperation means credentials work
		// but lack permission for this specific operation/model
		if (
			errorName === "AccessDeniedException" ||
			errorName === "UnauthorizedOperation"
		) {
			log.warn(
				`Region ${region} returned ${errorName} - credentials are valid but access is restricted`,
			);
			return true;
		}

		// Invalid region or service not available
		if (
			errorMessage?.includes("service not available") ||
			errorMessage?.includes("Invalid region") ||
			errorName === "InvalidRegionException"
		) {
			log.error(`Region ${region} is invalid or Bedrock is not available`);
			return false;
		}

		// Credential errors (InvalidAccessKeyId, SignatureDoesNotMatch, etc.)
		log.error(
			`Region ${region} validation failed with error: ${errorName} - ${errorMessage}`,
		);
		return false;
	}
}
