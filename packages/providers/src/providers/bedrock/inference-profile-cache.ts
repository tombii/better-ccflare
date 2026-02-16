import {
	BedrockClient,
	ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { createBedrockCredentialChain, parseBedrockConfig } from "./index";
import type { CrossRegionMode } from "./model-transformer";

const log = new Logger("BedrockInferenceProfileCache");

/**
 * Inference profile information from AWS Bedrock
 */
interface InferenceProfileInfo {
	/** Profile ID (e.g., "us.anthropic.claude-opus-4-6") */
	profileId: string;
	/** Normalized base model ID (e.g., "claude-opus-4-6") */
	modelId: string;
	/** Supported geographic prefixes (e.g., ["us", "eu", "apac"]) */
	geographic: string[];
	/** Whether this model supports global inference profiles */
	supportsGlobal: boolean;
	/** Whether this model supports regional (no prefix) mode */
	supportsRegional: boolean;
}

/**
 * In-memory cache for inference profiles per region
 * Key: region (e.g., "us-east-1")
 * Value: Array of inference profile info
 */
const inferenceProfileCache = new Map<string, InferenceProfileInfo[]>();

/**
 * Cache TTL in milliseconds (6 hours)
 * Inference profiles don't change frequently, refresh every 6 hours
 * Can be overridden via BEDROCK_INFERENCE_PROFILE_CACHE_TTL_HOURS env var
 */
const CACHE_TTL_MS =
	(Number.parseInt(
		process.env.BEDROCK_INFERENCE_PROFILE_CACHE_TTL_HOURS || "6",
		10,
	) || 6) *
	60 *
	60 *
	1000;

/**
 * Last cache refresh timestamp per region
 */
const lastRefresh = new Map<string, number>();

/**
 * Exponential backoff configuration for API retries
 */
const RETRY_CONFIG = {
	maxRetries: 3,
	initialDelayMs: 1000,
	maxDelayMs: 10000,
	backoffMultiplier: 2,
};

/**
 * Maximum number of regions to cache (safety limit to prevent unbounded growth)
 * In practice, users typically use 1-3 regions
 */
const MAX_CACHED_REGIONS = 20;

/**
 * Geographic prefixes supported by AWS Bedrock inference profiles
 */
const GEOGRAPHIC_PREFIXES = ["us", "eu", "apac", "au", "ca", "jp"] as const;

/**
 * Normalize a profile ID to extract the base model identifier
 * Removes geographic prefix, provider prefix, and version suffix
 *
 * Examples:
 * - "us.anthropic.claude-opus-4-6-v1:0" → "claude-opus-4-6"
 * - "eu.anthropic.claude-3-5-sonnet-20241022-v2:0" → "claude-3-5-sonnet-20241022"
 * - "anthropic.claude-haiku-4-5-20251001-v1:0" → "claude-haiku-4-5-20251001"
 */
function normalizeProfileModelId(profileId: string): string {
	let normalized = profileId;

	// Remove geographic prefix (us., eu., etc.)
	normalized = normalized.replace(/^(us|eu|apac|au|ca|jp|global)\./, "");

	// Remove provider prefix (anthropic., etc.)
	normalized = normalized.replace(/^[^.]+\./, "");

	// Remove version suffix (-v1:0, -v2:0, etc.)
	normalized = normalized.replace(/-v\d+:\d+$/, "");

	return normalized.toLowerCase();
}

/**
 * Extract geographic prefix from a profile ID
 * Returns the prefix if it's a known geographic prefix, null otherwise
 *
 * Examples:
 * - "us.anthropic.claude-opus-4-6" → "us"
 * - "eu.anthropic.claude-3-5-sonnet" → "eu"
 * - "anthropic.claude-opus-4-6" → null
 * - "global.anthropic.claude-3-5-sonnet" → null (global is not geographic)
 */
function extractGeographicPrefix(profileId: string): string | null {
	for (const prefix of GEOGRAPHIC_PREFIXES) {
		if (profileId.startsWith(`${prefix}.`)) {
			return prefix;
		}
	}
	return null;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch inference profiles from AWS Bedrock API with exponential backoff retry
 */
async function fetchInferenceProfilesFromBedrockWithRetry(
	region: string,
	credentials: ReturnType<typeof createBedrockCredentialChain>,
	attempt: number = 0,
): Promise<InferenceProfileInfo[]> {
	const client = new BedrockClient({ region, credentials });

	try {
		const command = new ListInferenceProfilesCommand({
			maxResults: 1000, // Get as many as possible in one call
		});

		const response = await client.send(command);

		if (
			!response.inferenceProfileSummaries ||
			response.inferenceProfileSummaries.length === 0
		) {
			log.warn(`No inference profiles found in region ${region}`);
			return [];
		}

		// Group profiles by model to aggregate geographic support
		const profilesByModel = new Map<
			string,
			{
				geographic: Set<string>;
				hasGlobal: boolean;
				hasRegional: boolean;
			}
		>();

		for (const profile of response.inferenceProfileSummaries) {
			if (!profile.inferenceProfileId) {
				continue;
			}

			const profileId = profile.inferenceProfileId;
			const modelId = normalizeProfileModelId(profileId);
			const geoPrefix = extractGeographicPrefix(profileId);
			const isGlobal = profileId.startsWith("global.");
			const isRegional = !geoPrefix && !isGlobal;

			// Get or create entry for this model
			let entry = profilesByModel.get(modelId);
			if (!entry) {
				entry = {
					geographic: new Set(),
					hasGlobal: false,
					hasRegional: false,
				};
				profilesByModel.set(modelId, entry);
			}

			// Update capabilities
			if (geoPrefix) {
				entry.geographic.add(geoPrefix);
			}
			if (isGlobal) {
				entry.hasGlobal = true;
			}
			if (isRegional) {
				entry.hasRegional = true;
			}
		}

		// Convert to InferenceProfileInfo array
		const profiles: InferenceProfileInfo[] = Array.from(
			profilesByModel.entries(),
		).map(([modelId, capabilities]) => ({
			profileId: modelId, // Store normalized ID as the profile ID
			modelId,
			geographic: Array.from(capabilities.geographic).sort(),
			supportsGlobal: capabilities.hasGlobal,
			supportsRegional: capabilities.hasRegional,
		}));

		log.info(
			`Loaded ${profiles.length} inference profiles from Bedrock in region ${region}`,
		);

		return profiles;
	} catch (error) {
		const errorMessage = (error as Error).message;

		// Check if this is a permissions error
		if (
			errorMessage.includes("AccessDeniedException") ||
			errorMessage.includes("UnauthorizedException") ||
			errorMessage.includes("not authorized")
		) {
			log.error(
				`Failed to fetch inference profiles from Bedrock (region: ${region}): ${errorMessage}\n` +
					`Ensure your AWS credentials have the 'bedrock:ListInferenceProfiles' permission.\n` +
					`Add this to your IAM policy:\n` +
					`{\n` +
					`  "Effect": "Allow",\n` +
					`  "Action": "bedrock:ListInferenceProfiles",\n` +
					`  "Resource": "*"\n` +
					`}`,
			);
			throw error;
		}

		// Check if we should retry (throttling, network errors, etc.)
		const shouldRetry =
			attempt < RETRY_CONFIG.maxRetries &&
			(errorMessage.includes("ThrottlingException") ||
				errorMessage.includes("TooManyRequestsException") ||
				errorMessage.includes("ServiceUnavailableException") ||
				errorMessage.includes("RequestTimeout") ||
				errorMessage.includes("ECONNRESET") ||
				errorMessage.includes("ETIMEDOUT"));

		if (shouldRetry) {
			// Calculate backoff delay with exponential backoff
			const baseDelay =
				RETRY_CONFIG.initialDelayMs * RETRY_CONFIG.backoffMultiplier ** attempt;
			const delayMs = Math.min(baseDelay, RETRY_CONFIG.maxDelayMs);

			log.warn(
				`Bedrock API call failed (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}), retrying in ${delayMs}ms: ${errorMessage}`,
			);

			await sleep(delayMs);
			return fetchInferenceProfilesFromBedrockWithRetry(
				region,
				credentials,
				attempt + 1,
			);
		}

		log.error(
			`Failed to fetch inference profiles from Bedrock after ${attempt + 1} attempts (region: ${region}): ${errorMessage}`,
		);
		throw error;
	}
}

/**
 * Evict oldest cached region if cache size exceeds MAX_CACHED_REGIONS
 * This prevents unbounded memory growth if users configure many regions
 */
function evictOldestRegionIfNeeded(): void {
	if (inferenceProfileCache.size < MAX_CACHED_REGIONS) {
		return;
	}

	// Find the oldest cached region by last refresh time
	let oldestRegion: string | null = null;
	let oldestTime = Number.POSITIVE_INFINITY;

	for (const [region, timestamp] of lastRefresh.entries()) {
		if (timestamp < oldestTime) {
			oldestTime = timestamp;
			oldestRegion = region;
		}
	}

	if (oldestRegion) {
		log.info(
			`Evicting oldest region from inference profile cache: ${oldestRegion} (cache size: ${inferenceProfileCache.size})`,
		);
		inferenceProfileCache.delete(oldestRegion);
		lastRefresh.delete(oldestRegion);
	}
}

/**
 * Get or refresh the inference profile cache for a specific region
 */
async function getOrRefreshCache(
	region: string,
	credentials: ReturnType<typeof createBedrockCredentialChain>,
): Promise<InferenceProfileInfo[]> {
	const now = Date.now();
	const lastRefreshTime = lastRefresh.get(region) || 0;
	const cacheAge = now - lastRefreshTime;

	// Return cached profiles if cache is fresh
	if (inferenceProfileCache.has(region) && cacheAge < CACHE_TTL_MS) {
		log.debug(
			`Using cached inference profiles for region ${region} (age: ${cacheAge}ms)`,
		);
		return inferenceProfileCache.get(region)!;
	}

	// Evict oldest region if we're at capacity and adding a new region
	if (!inferenceProfileCache.has(region)) {
		evictOldestRegionIfNeeded();
	}

	// Cache is stale or doesn't exist, refresh it
	log.info(`Refreshing inference profile cache for region ${region}`);
	const profiles = await fetchInferenceProfilesFromBedrockWithRetry(
		region,
		credentials,
	);

	inferenceProfileCache.set(region, profiles);
	lastRefresh.set(region, now);

	return profiles;
}

/**
 * Extract model short name from a full model ID for lookup
 * Example: "us.anthropic.claude-3-5-sonnet-20241022-v2:0" → "claude-3-5-sonnet-20241022"
 */
function extractModelShortName(modelId: string): string {
	let normalized = modelId;

	// Remove geographic prefix (us., eu., etc.)
	normalized = normalized.replace(/^(us|eu|apac|au|ca|jp|global)\./, "");

	// Remove provider prefix (anthropic., etc.)
	normalized = normalized.replace(/^[^.]+\./, "");

	// Remove version suffix (-v1:0, -v2:0, etc.)
	normalized = normalized.replace(/-v\d+:\d+$/, "");

	return normalized.toLowerCase();
}

/**
 * Check if a model supports the requested inference profile mode.
 * Returns true if supported, false otherwise.
 *
 * @param modelId - Model ID (e.g., "claude-opus-4-6", "us.anthropic.claude-3-5-sonnet-v2:0")
 * @param mode - Cross-region mode to check
 * @param account - Bedrock account with region/credentials
 * @returns True if the model supports the requested mode, false otherwise
 */
export async function canUseInferenceProfile(
	modelId: string,
	mode: CrossRegionMode,
	account: Account,
): Promise<boolean> {
	const config = parseBedrockConfig(account.custom_endpoint);

	if (!config) {
		log.error(
			`Invalid Bedrock config for account ${account.name}: expected format "bedrock:profile:region"`,
		);
		return false;
	}

	try {
		// Get or refresh inference profile cache for this region
		const credentials = createBedrockCredentialChain(account);
		const profiles = await getOrRefreshCache(config.region, credentials);

		if (profiles.length === 0) {
			log.warn(
				`No inference profiles available in cache for region ${config.region}, assuming support`,
			);
			return true;
		}

		// Extract model short name for matching
		const shortName = extractModelShortName(modelId);

		// Find matching profile
		const profile = profiles.find((p) => p.modelId === shortName);

		if (!profile) {
			log.warn(
				`Unknown model "${shortName}" (from "${modelId}"), assuming inference profile support`,
			);
			return true;
		}

		// Check mode support
		switch (mode) {
			case "geographic":
				return profile.geographic.length > 0;
			case "global":
				return profile.supportsGlobal;
			case "regional":
				return profile.supportsRegional;
			default:
				log.warn(`Unknown CrossRegionMode: ${mode as string}`);
				return true;
		}
	} catch (error) {
		log.error(
			`Error checking inference profile support for model "${modelId}" (mode: ${mode}): ${(error as Error).message}`,
		);
		// Return true to allow the request to proceed (let Bedrock validate)
		return true;
	}
}

/**
 * Get a fallback mode if the requested mode is not supported.
 * Returns null if no fallback is needed (mode is supported) or if no fallback exists.
 *
 * @param modelId - Model ID to check
 * @param requestedMode - The mode that was requested
 * @param account - Bedrock account with region/credentials
 * @returns Fallback mode or null
 */
export async function getFallbackMode(
	modelId: string,
	requestedMode: CrossRegionMode,
	account: Account,
): Promise<CrossRegionMode | null> {
	// Check if requested mode is supported
	const supportsRequested = await canUseInferenceProfile(
		modelId,
		requestedMode,
		account,
	);

	if (supportsRequested) {
		// No fallback needed
		return null;
	}

	// Try fallback order: global -> geographic -> regional
	const fallbackOrder: CrossRegionMode[] = ["global", "geographic", "regional"];

	for (const fallback of fallbackOrder) {
		if (fallback === requestedMode) {
			continue;
		}

		const supportsFallback = await canUseInferenceProfile(
			modelId,
			fallback,
			account,
		);

		if (supportsFallback) {
			return fallback;
		}
	}

	return null;
}

/**
 * Clear the inference profile cache (useful for testing or forced refresh)
 */
export function clearInferenceProfileCache(): void {
	inferenceProfileCache.clear();
	lastRefresh.clear();
	log.info("Inference profile cache cleared");
}
