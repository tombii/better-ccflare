import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockErrorHandler");

/**
 * Translate AWS SDK Bedrock errors to user-friendly messages
 *
 * This function catches common SigV4 signing and credential errors
 * and converts them to actionable messages for users.
 *
 * Note: AWS SDK (@aws-sdk/client-bedrock-runtime) handles SigV4 signing automatically,
 * including payload transformation, canonical request generation, and signature calculation.
 * This utility only translates errors when signing fails (e.g., bad credentials).
 *
 * @param error - Error from AWS SDK (thrown by BedrockRuntimeClient)
 * @returns User-friendly error message (never throws, always returns a string)
 *
 * Example usage:
 * ```typescript
 * try {
 *   const response = await client.send(command);
 * } catch (error) {
 *   const userMessage = translateBedrockError(error);
 *   throw new Error(userMessage);
 * }
 * ```
 */
export function translateBedrockError(error: unknown): string {
	const errorName = (error as { name?: string }).name;
	const errorMessage = (error as { message?: string }).message;

	// Invalid access key ID
	if (errorName === "InvalidAccessKeyId") {
		log.warn("InvalidAccessKeyId: AWS access key ID is not valid");
		return "Your AWS access key ID is not valid. Please check your credentials and try again.";
	}

	// Signature mismatch (wrong secret key)
	if (errorName === "SignatureDoesNotMatch") {
		log.warn("SignatureDoesNotMatch: AWS signature verification failed");
		return "AWS signature verification failed. Please check your secret access key and try again.";
	}

	// Expired temporary credentials
	if (errorName === "ExpiredToken") {
		log.warn("ExpiredToken: Temporary AWS credentials have expired");
		return "Your temporary AWS credentials have expired. Please re-authenticate or refresh your credentials.";
	}

	// Invalid session token
	if (errorName === "InvalidClientTokenId") {
		log.warn("InvalidClientTokenId: AWS security token is not valid");
		return "Your AWS session token is not valid. Please check your credentials and try again.";
	}

	// Unrecognized client (access key doesn't exist)
	if (errorName === "UnrecognizedClientException") {
		log.warn("UnrecognizedClientException: AWS access key does not exist");
		return "Your AWS access key does not exist or is not active. Please check your credentials.";
	}

	// Log unknown errors for debugging
	log.error(`Unknown Bedrock error: ${errorName} - ${errorMessage}`);

	// Return original error message for unknown errors
	return (
		errorMessage ||
		"An unknown error occurred with AWS Bedrock. Please try again."
	);
}
