/**
 * Bedrock provider utilities
 *
 * This module exports foundational utilities for AWS Bedrock integration:
 * - Custom credential provider chain (env vars → AWS profiles → IAM role)
 * - Region validation
 * - SigV4 error translation
 *
 * These utilities are used by BedrockProvider (Phase 2) and CLI commands (Phase 6).
 *
 * Note: AWS SDK v3 (@aws-sdk/client-bedrock-runtime) handles SigV4 signing automatically,
 * including payload transformation, canonical request generation, and signature calculation.
 * No manual SigV4 implementation is needed.
 *
 * Note: Credentials are read from AWS profiles in ~/.aws/credentials (no database storage in v1).
 * Profile name and region are stored in custom_endpoint field (format: "bedrock:profile-name:region").
 *
 * User adds Bedrock account with: --mode bedrock --profile my-aws-profile --region us-east-1
 * CLI stores: custom_endpoint = "bedrock:my-aws-profile:us-east-1"
 */

export {
	createBedrockCredentialChain,
	parseBedrockConfig,
} from "./credentials";
export { translateBedrockError } from "./error-handler";
export { BedrockProvider } from "./provider";
export { validateBedrockRegion } from "./region-validator";
export {
	detectStreamingMode,
	supportsStreaming,
	transformMessagesRequest,
	transformStreamingRequest,
} from "./request-transformer";
