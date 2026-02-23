import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockModelTransformer");

export type CrossRegionMode = "geographic" | "global" | "regional";

// Geographic prefixes supported by AWS Bedrock inference profiles
const GEOGRAPHIC_PREFIXES = ["us", "eu", "apac", "au", "ca", "jp"] as const;

// All prefixes including global
const ALL_PREFIXES = [...GEOGRAPHIC_PREFIXES, "global"] as const;

/**
 * Map an AWS region to the correct Bedrock cross-region inference profile geographic prefix.
 * Falls back to "us" if the region is unknown.
 *
 * Sources: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
 */
export function regionToGeographicPrefix(region: string): string {
	if (region.startsWith("eu-")) return "eu";
	if (region.startsWith("ca-")) return "ca";
	if (region === "ap-northeast-1" || region === "ap-northeast-3") return "jp";
	if (
		region === "ap-southeast-2" ||
		region === "ap-southeast-4"
	)
		return "au";
	if (region.startsWith("ap-") || region.startsWith("me-")) return "apac";
	// us-east-*, us-west-*, us-gov-* all use "us" (gov handled separately)
	return "us";
}

/**
 * Parse a Bedrock model ID into its components.
 * Handles formats like:
 *   "us.anthropic.claude-3-5-sonnet-20241022-v2:0" -> prefix="us", rest="anthropic.claude-3-5-sonnet-20241022-v2:0"
 *   "global.anthropic.claude-3-5-sonnet-20241022-v2:0" -> prefix="global", rest="anthropic.claude-3-5-sonnet-20241022-v2:0"
 *   "anthropic.claude-3-5-sonnet-20241022-v2:0" -> prefix=null, rest="anthropic.claude-3-5-sonnet-20241022-v2:0"
 */
function parseModelId(modelId: string): {
	prefix: string | null;
	rest: string;
} {
	for (const prefix of ALL_PREFIXES) {
		if (modelId.startsWith(`${prefix}.`)) {
			return { prefix, rest: modelId.slice(prefix.length + 1) };
		}
	}
	return { prefix: null, rest: modelId };
}

/**
 * Transform a Bedrock model ID prefix based on cross-region mode.
 *
 * - geographic: Add region-appropriate prefix if no prefix exists; preserve existing geo prefix
 * - global: Replace any prefix with "global."
 * - regional: Strip all geographic/global prefixes, return bare model ID
 *
 * @param modelId - Bedrock model ID (e.g., "anthropic.claude-haiku-4-5-20251001-v1:0")
 * @param mode - Cross-region mode
 * @param region - AWS region (e.g., "eu-central-1") used to derive the correct geographic prefix
 */
export function transformModelIdPrefix(
	modelId: string,
	mode: CrossRegionMode,
	region?: string,
): string {
	const { prefix, rest } = parseModelId(modelId);

	switch (mode) {
		case "geographic": {
			if (prefix !== null && GEOGRAPHIC_PREFIXES.includes(prefix as never)) {
				// Already has geographic prefix, leave it
				return modelId;
			}
			// Derive prefix from region, falling back to "us"
			const geoPrefix = region ? regionToGeographicPrefix(region) : "us";
			return `${geoPrefix}.${rest}`;
		}
		case "global": {
			// Replace any prefix with "global."
			return `global.${rest}`;
		}
		case "regional": {
			// Strip all prefixes, return bare model ID
			return rest;
		}
		default: {
			log.warn(`Unknown CrossRegionMode: ${mode as string}, returning as-is`);
			return modelId;
		}
	}
}
