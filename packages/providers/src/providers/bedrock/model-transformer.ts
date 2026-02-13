import { Logger } from "@better-ccflare/logger";

const log = new Logger("BedrockModelTransformer");

export type CrossRegionMode = "geographic" | "global" | "regional";

// Geographic prefixes supported by AWS Bedrock inference profiles
const GEOGRAPHIC_PREFIXES = ["us", "eu", "apac", "au", "ca", "jp"] as const;

// All prefixes including global
const ALL_PREFIXES = [...GEOGRAPHIC_PREFIXES, "global"] as const;

// Known models and their inference profile support
// Source: AWS Bedrock inference profiles support documentation
const INFERENCE_PROFILE_SUPPORT: Record<
	string,
	{
		geographic: string[];
		global: boolean;
		regional: boolean;
	}
> = {
	// Claude 4.x models
	"claude-opus-4-6": {
		geographic: ["us"],
		global: false,
		regional: true,
	},
	"claude-opus-4-6-v1": {
		geographic: ["us"],
		global: false,
		regional: true,
	},
	"claude-sonnet-4-5": {
		geographic: ["us"],
		global: false,
		regional: true,
	},
	"claude-sonnet-4-5-v1": {
		geographic: ["us"],
		global: false,
		regional: true,
	},
	// Claude 3.5 models
	"claude-3-5-sonnet": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	"claude-3-5-sonnet-20241022": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	"claude-3-5-sonnet-20240620": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	"claude-3-5-haiku": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	"claude-3-5-haiku-20241022": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	// Claude 3 models
	"claude-3-opus": { geographic: ["us", "eu"], global: false, regional: true },
	"claude-3-opus-20240229": {
		geographic: ["us", "eu"],
		global: false,
		regional: true,
	},
	"claude-3-sonnet": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	"claude-3-sonnet-20240229": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	"claude-3-haiku": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
	"claude-3-haiku-20240307": {
		geographic: ["us", "eu", "apac"],
		global: false,
		regional: true,
	},
};

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
 * Extract a model short name from the full model ID for lookup in INFERENCE_PROFILE_SUPPORT.
 * Example: "us.anthropic.claude-3-5-sonnet-20241022-v2:0" -> "claude-3-5-sonnet-20241022"
 */
function extractModelShortName(modelId: string): string {
	const { rest } = parseModelId(modelId);
	// rest is like "anthropic.claude-3-5-sonnet-20241022-v2:0"
	// strip the provider prefix (e.g. "anthropic.")
	const dotIndex = rest.indexOf(".");
	if (dotIndex === -1) {
		return rest;
	}
	const modelPart = rest.slice(dotIndex + 1);
	// Strip version suffix like "-v2:0", "-v1:0"
	return modelPart.replace(/-v\d+:\d+$/, "");
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

/**
 * Check if a model supports the requested inference profile mode.
 * Returns true optimistically if model is unknown (let Bedrock validate).
 */
export function canUseInferenceProfile(
	modelId: string,
	mode: CrossRegionMode,
): boolean {
	const shortName = extractModelShortName(modelId);
	const support = INFERENCE_PROFILE_SUPPORT[shortName];

	if (!support) {
		log.warn(
			`Unknown model "${shortName}" (from "${modelId}"), assuming inference profile support`,
		);
		return true;
	}

	switch (mode) {
		case "geographic":
			return support.geographic.length > 0;
		case "global":
			return support.global;
		case "regional":
			return support.regional;
		default:
			log.warn(`Unknown CrossRegionMode: ${mode as string}`);
			return true;
	}
}

/**
 * Get a fallback mode if the requested mode is not supported.
 * Returns null if no fallback is needed (mode is supported) or if no fallback exists.
 */
export function getFallbackMode(
	modelId: string,
	requestedMode: CrossRegionMode,
): CrossRegionMode | null {
	if (canUseInferenceProfile(modelId, requestedMode)) {
		// No fallback needed
		return null;
	}

	// Try fallback order: global -> geographic -> regional
	const fallbackOrder: CrossRegionMode[] = ["global", "geographic", "regional"];
	for (const fallback of fallbackOrder) {
		if (
			fallback !== requestedMode &&
			canUseInferenceProfile(modelId, fallback)
		) {
			return fallback;
		}
	}

	return null;
}
