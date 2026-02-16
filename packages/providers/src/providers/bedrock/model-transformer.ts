import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockModelTransformer");

export type CrossRegionMode = "geographic" | "global" | "regional";

// Geographic prefixes supported by AWS Bedrock inference profiles
const GEOGRAPHIC_PREFIXES = ["us", "eu", "apac", "au", "ca", "jp"] as const;

// All prefixes including global
const ALL_PREFIXES = [...GEOGRAPHIC_PREFIXES, "global"] as const;

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
 * - geographic: Add "us." prefix if no prefix exists; preserve existing geo prefix
 * - global: Replace any prefix with "global."
 * - regional: Strip all geographic/global prefixes, return bare model ID
 */
export function transformModelIdPrefix(
	modelId: string,
	mode: CrossRegionMode,
): string {
	const { prefix, rest } = parseModelId(modelId);

	switch (mode) {
		case "geographic": {
			if (prefix !== null && GEOGRAPHIC_PREFIXES.includes(prefix as never)) {
				// Already has geographic prefix, leave it
				return modelId;
			}
			// Add default "us." prefix
			return `us.${rest}`;
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
