import {
	createCredentialChain,
	fromEnv,
	fromIni,
} from "@aws-sdk/credential-providers";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { AwsCredentialIdentity, Provider } from "@smithy/types";

const log = new Logger("BedrockCredentials");

/**
 * Parse AWS profile name and region from custom_endpoint field
 *
 * Format: "bedrock:profile-name:region"
 * Example: "bedrock:my-aws-profile:us-east-1"
 *
 * This format is stored in the custom_endpoint field when user adds Bedrock account:
 * CLI command: --mode bedrock --profile my-aws-profile --region us-east-1
 * Storage: account.custom_endpoint = "bedrock:my-aws-profile:us-east-1"
 *
 * @param customEndpoint - Value from Account.custom_endpoint field
 * @returns Object with profile and region, or undefined if invalid format
 */
export function parseBedrockConfig(customEndpoint: string | undefined | null):
	| {
			profile: string;
			region: string;
	  }
	| undefined {
	if (!customEndpoint) {
		log.warn("No custom_endpoint configured for Bedrock account");
		return undefined;
	}

	// Parse format: "bedrock:profile:region"
	const parts = customEndpoint.split(":");
	if (parts.length !== 3 || parts[0] !== "bedrock") {
		log.error(
			`Invalid custom_endpoint format: ${customEndpoint}. Expected format: bedrock:profile:region`,
		);
		return undefined;
	}

	const [, profile, region] = parts;
	return { profile, region };
}

/**
 * Create Bedrock credential provider chain with custom resolution order
 *
 * Resolution order (priority):
 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
 * 2. AWS profiles from ~/.aws/credentials (using specified profile)
 * 3. IAM role via instance metadata (when running on EC2/ECS)
 *
 * Note: No database credential resolution in v1. Credentials are read from
 * AWS profiles in ~/.aws/credentials. Profile name is stored in custom_endpoint.
 *
 * @param account - Account configuration with custom_endpoint format "bedrock:profile:region"
 * @returns Provider function that resolves credentials in priority order
 *
 * Example usage:
 * ```typescript
 * const credentials = createBedrockCredentialChain(account);
 * const config = parseBedrockConfig(account.custom_endpoint);
 * const client = new BedrockRuntimeClient({
 *   region: config?.region || "us-east-1",
 *   credentials,
 * });
 * ```
 */
export function createBedrockCredentialChain(
	account: Account,
): Provider<AwsCredentialIdentity> {
	// Parse profile name from custom_endpoint
	const bedrockConfig = parseBedrockConfig(account.custom_endpoint);

	if (!bedrockConfig) {
		log.error(
			`Invalid Bedrock configuration for account ${account.name}. custom_endpoint should be in format: bedrock:profile:region`,
		);
		// Return a provider that will throw a clear error
		return async () => {
			throw new Error(
				`Invalid Bedrock configuration for account "${account.name}". custom_endpoint should be in format: bedrock:profile:region. Current value: "${account.custom_endpoint}"`,
			);
		};
	}

	const { profile } = bedrockConfig;

	log.info(
		`Creating Bedrock credential chain for account ${account.name} using profile: ${profile}`,
	);

	// Build credential chain with specified profile
	return createCredentialChain(
		// Priority 1: Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
		fromEnv(),
		// Priority 2: AWS profile from ~/.aws/credentials
		fromIni({ profile }),
		// Priority 3: IAM role (instance metadata) - implicit fallback
	);
}
