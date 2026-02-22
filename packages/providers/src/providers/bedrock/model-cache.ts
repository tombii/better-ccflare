import {
	BedrockClient,
	type FoundationModelSummary,
	ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { createBedrockCredentialChain, parseBedrockConfig } from "./index";

const log = new Logger("BedrockModelCache");

/**
 * Model information from AWS Bedrock
 */
interface BedrockModel {
	/** Full Bedrock model ID (e.g., "anthropic.claude-opus-4-6-v1:0") */
	modelId: string;
	/** Normalized search key for fuzzy matching */
	searchKey: string;
}

/**
 * In-memory cache for Bedrock models per region
 * Key: region (e.g., "us-east-1")
 * Value: Array of Bedrock models
 */
const modelCache = new Map<string, BedrockModel[]>();

/**
 * Cache TTL in milliseconds (6 hours)
 * Models don't change frequently, refresh every 6 hours
 * Can be overridden via BEDROCK_MODEL_CACHE_TTL_HOURS env var
 */
const CACHE_TTL_MS =
	(Number.parseInt(process.env.BEDROCK_MODEL_CACHE_TTL_HOURS || "6", 10) || 6) *
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
 * Normalize a model name for fuzzy matching
 * Removes prefixes, version suffixes, and standardizes format
 *
 * Examples:
 * - "anthropic.claude-opus-4-6-v1:0" → "claude-opus-4-6"
 * - "us.anthropic.claude-3-5-sonnet-20241022-v2:0" → "claude-3-5-sonnet-20241022"
 * - "claude-opus-4-6" → "claude-opus-4-6"
 */
function normalizeModelName(modelId: string): string {
	let normalized = modelId;

	// Remove geographic prefix (us., eu., etc.)
	normalized = normalized.replace(/^(us|eu|apac|au|ca|jp|global)\./, "");

	// Remove provider prefix (anthropic., etc.)
	normalized = normalized.replace(/^[^.]+\./, "");

	// Remove version suffix (-v1:0, -v2:0, -v1, -v2, etc.)
	normalized = normalized.replace(/-v\d+(:\d+)?$/, "");

	return normalized.toLowerCase();
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch models from AWS Bedrock API with exponential backoff retry
 */
async function fetchModelsFromBedrockWithRetry(
	region: string,
	credentials: ReturnType<typeof createBedrockCredentialChain>,
	attempt: number = 0,
): Promise<BedrockModel[]> {
	const client = new BedrockClient({ region, credentials });

	try {
		const command = new ListFoundationModelsCommand({
			byProvider: "Anthropic",
		});

		const response = await client.send(command);

		if (!response.modelSummaries || response.modelSummaries.length === 0) {
			log.warn(`No Anthropic models found in region ${region}`);
			return [];
		}

		const models: BedrockModel[] = response.modelSummaries
			.filter((model): model is FoundationModelSummary => !!model.modelId)
			.map((model) => ({
				modelId: model.modelId!,
				searchKey: normalizeModelName(model.modelId!),
			}));

		log.info(
			`Loaded ${models.length} Anthropic models from Bedrock in region ${region}`,
		);

		return models;
	} catch (error) {
		const errorMessage = (error as Error).message;

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
			return fetchModelsFromBedrockWithRetry(region, credentials, attempt + 1);
		}

		log.error(
			`Failed to fetch models from Bedrock after ${attempt + 1} attempts (region: ${region}): ${errorMessage}`,
		);
		throw error;
	}
}

/**
 * Evict oldest cached region if cache size exceeds MAX_CACHED_REGIONS
 * This prevents unbounded memory growth if users configure many regions
 */
function evictOldestRegionIfNeeded(): void {
	if (modelCache.size < MAX_CACHED_REGIONS) {
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
			`Evicting oldest region from cache: ${oldestRegion} (cache size: ${modelCache.size})`,
		);
		modelCache.delete(oldestRegion);
		lastRefresh.delete(oldestRegion);
	}
}

/**
 * Get or refresh the model cache for a specific region
 */
async function getOrRefreshCache(
	region: string,
	credentials: ReturnType<typeof createBedrockCredentialChain>,
): Promise<BedrockModel[]> {
	const now = Date.now();
	const lastRefreshTime = lastRefresh.get(region) || 0;
	const cacheAge = now - lastRefreshTime;

	// Return cached models if cache is fresh
	if (modelCache.has(region) && cacheAge < CACHE_TTL_MS) {
		log.debug(`Using cached models for region ${region} (age: ${cacheAge}ms)`);
		return modelCache.get(region)!;
	}

	// Evict oldest region if we're at capacity and adding a new region
	if (!modelCache.has(region)) {
		evictOldestRegionIfNeeded();
	}

	// Cache is stale or doesn't exist, refresh it
	log.info(`Refreshing model cache for region ${region}`);
	const models = await fetchModelsFromBedrockWithRetry(region, credentials);

	modelCache.set(region, models);
	lastRefresh.set(region, now);

	return models;
}

/**
 * Calculate similarity score between two normalized model names
 * Returns a score from 0 (no match) to 1 (exact match)
 */
function calculateSimilarity(a: string, b: string): number {
	// Exact match
	if (a === b) return 1.0;

	// Substring match
	if (a.includes(b) || b.includes(a)) return 0.8;

	// Simple Levenshtein distance
	const maxLength = Math.max(a.length, b.length);
	const distance = levenshteinDistance(a, b);
	const similarity = 1 - distance / maxLength;

	return similarity;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
	const matrix: number[][] = [];

	// Initialize matrix
	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}

	// Fill matrix
	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1, // substitution
					matrix[i][j - 1] + 1, // insertion
					matrix[i - 1][j] + 1, // deletion
				);
			}
		}
	}

	return matrix[b.length][a.length];
}

/**
 * Translate a client model name to a Bedrock model ID using fuzzy matching
 *
 * @param clientModelName - Client-provided model name (e.g., "claude-opus-4-6")
 * @param account - Bedrock account with region/credentials
 * @returns Bedrock model ID or null if no match found
 */
export async function translateModelName(
	clientModelName: string,
	account: Account,
): Promise<string | null> {
	const config = parseBedrockConfig(account.custom_endpoint);

	if (!config) {
		log.error(
			`Invalid Bedrock config for account ${account.name}: expected format "bedrock:profile:region"`,
		);
		return null;
	}

	// Get or refresh model cache for this region
	const credentials = createBedrockCredentialChain(account);
	const models = await getOrRefreshCache(config.region, credentials);

	if (models.length === 0) {
		log.warn(`No models available in cache for region ${config.region}`);
		return null;
	}

	// Normalize the client model name for matching
	const normalizedClient = normalizeModelName(clientModelName);

	// Find best match using fuzzy matching
	let bestMatch: BedrockModel | null = null;
	let bestScore = 0;

	for (const model of models) {
		const score = calculateSimilarity(normalizedClient, model.searchKey);

		// Require at least 70% similarity to consider it a match
		if (score > bestScore && score >= 0.7) {
			bestScore = score;
			bestMatch = model;
		}
	}

	if (bestMatch) {
		log.info(
			`Matched client model "${clientModelName}" to Bedrock model "${bestMatch.modelId}" (similarity: ${(bestScore * 100).toFixed(1)}%)`,
		);
		return bestMatch.modelId;
	}

	log.debug(
		`No fuzzy match found for client model "${clientModelName}" (best score: ${(bestScore * 100).toFixed(1)}%)`,
	);
	return null;
}

/**
 * Clear the model cache (useful for testing or forced refresh)
 */
export function clearModelCache(): void {
	modelCache.clear();
	lastRefresh.clear();
	log.info("Model cache cleared");
}
