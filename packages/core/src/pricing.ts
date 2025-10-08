import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIME_CONSTANTS } from "./constants";
import { CLAUDE_MODEL_IDS, MODEL_DISPLAY_NAMES } from "./models";

export interface TokenBreakdown {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

interface ModelCost {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
}

interface ModelDef {
	id: string;
	name: string;
	cost?: ModelCost;
}

interface ApiResponse {
	[provider: string]: {
		models?: {
			[modelId: string]: ModelDef;
		};
	};
}

// Bundled fallback pricing for Anthropic models (dollars per 1M tokens)
const BUNDLED_PRICING: ApiResponse = {
	anthropic: {
		models: {
			[CLAUDE_MODEL_IDS.HAIKU_3_5]: {
				id: CLAUDE_MODEL_IDS.HAIKU_3_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.HAIKU_3_5],
				cost: {
					input: 0.8,
					output: 4,
					cache_read: 0.08,
					cache_write: 1,
				},
			},
			[CLAUDE_MODEL_IDS.SONNET_3_5]: {
				id: CLAUDE_MODEL_IDS.SONNET_3_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.SONNET_3_5],
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
			[CLAUDE_MODEL_IDS.SONNET_4]: {
				id: CLAUDE_MODEL_IDS.SONNET_4,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.SONNET_4],
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
			[CLAUDE_MODEL_IDS.SONNET_4_5]: {
				id: CLAUDE_MODEL_IDS.SONNET_4_5,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.SONNET_4_5],
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4]: {
				id: CLAUDE_MODEL_IDS.OPUS_4,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4],
				cost: {
					input: 15,
					output: 75,
					cache_read: 1.5,
					cache_write: 18.75,
				},
			},
			[CLAUDE_MODEL_IDS.OPUS_4_1]: {
				id: CLAUDE_MODEL_IDS.OPUS_4_1,
				name: MODEL_DISPLAY_NAMES[CLAUDE_MODEL_IDS.OPUS_4_1],
				cost: {
					input: 15,
					output: 75,
					cache_read: 1.5,
					cache_write: 18.75,
				},
			},
		},
	},
};

// Pricing for Zhipu AI models (GLM models)
BUNDLED_PRICING.zai = {
	models: {
		"glm-4.5": {
			id: "glm-4.5",
			name: "GLM-4.5",
			cost: {
				input: 0.6,
				output: 2.2,
				cache_read: 0.11,
				cache_write: 0,
			},
		},
		"glm-4.5-air": {
			id: "glm-4.5-air",
			name: "GLM-4.5-Air",
			cost: {
				input: 0.2,
				output: 1.1,
				cache_read: 0.03,
				cache_write: 0,
			},
		},
		"glm-4.6": {
			id: "glm-4.6",
			name: "GLM-4.6",
			cost: {
				input: 0.6,
				output: 2.2,
				cache_read: 0.11,
				cache_write: 0,
			},
		},
		"glm-4.6-air": {
			id: "glm-4.6-air",
			name: "GLM-4.6-Air",
			cost: {
				input: 0.2,
				output: 1.1,
				cache_read: 0.03,
				cache_write: 0,
			},
		},
	},
};

interface Logger {
	warn(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

class PriceCatalogue {
	private static instance: PriceCatalogue;
	private priceData: ApiResponse | null = null;
	private lastFetch = 0;
	private warnedModels = new Set<string>();
	private logger: Logger | null = null;

	private constructor() {}

	setLogger(logger: Logger): void {
		this.logger = logger;
	}

	static get(): PriceCatalogue {
		if (!PriceCatalogue.instance) {
			PriceCatalogue.instance = new PriceCatalogue();
		}
		return PriceCatalogue.instance;
	}

	private getCacheDir(): string {
		return join(tmpdir(), "better-ccflare");
	}

	private getCachePath(): string {
		return join(this.getCacheDir(), "models.dev.json");
	}

	private getCacheDurationMs(): number {
		const hours = Number(process.env.CF_PRICING_REFRESH_HOURS) || 24;
		return hours * TIME_CONSTANTS.HOUR;
	}

	private async ensureCacheDir(): Promise<void> {
		try {
			await fs.mkdir(this.getCacheDir(), { recursive: true });
		} catch (error) {
			this.logger?.warn("Failed to create cache directory: %s", error);
		}
	}

	/**
	 * Merge remote pricing data with bundled pricing data to ensure all models are included
	 */
	private mergePricingData(
		remote: ApiResponse,
		bundled: ApiResponse,
	): ApiResponse {
		const merged: ApiResponse = {};

		// List of preferred providers in priority order
		const preferredProviders = ["zai", "anthropic"];

		// First, add preferred providers from remote data
		for (const providerName of preferredProviders) {
			if (remote[providerName]) {
				merged[providerName] = remote[providerName];
			}
		}

		// Then add remaining providers from remote data, filtering out problematic ones
		for (const [providerName, providerData] of Object.entries(remote)) {
			if (
				!merged[providerName] &&
				!this.shouldFilterProvider(providerName, providerData)
			) {
				merged[providerName] = providerData;
			}
		}

		// For each provider in bundled pricing, ensure it exists in merged data
		for (const [providerName, providerData] of Object.entries(bundled)) {
			if (!merged[providerName]) {
				this.logger?.warn(
					"Provider %s not found in remote pricing, using bundled data",
					providerName,
				);
				merged[providerName] = providerData;
			} else if (providerData.models) {
				// Merge models from bundled into remote data
				if (!merged[providerName].models) {
					merged[providerName].models = {};
				}

				// Add any missing models from bundled data
				let addedModels = 0;
				for (const [modelId, modelData] of Object.entries(
					providerData.models,
				)) {
					if (!merged[providerName].models?.[modelId]) {
						merged[providerName].models[modelId] = modelData;
						addedModels++;
					}
				}

				if (addedModels > 0) {
					this.logger?.debug(
						"Added %d missing models for provider %s from bundled pricing",
						addedModels,
						providerName,
					);
				}
			}
		}

		return merged;
	}

	/**
	 * Determine if a provider should be filtered out (e.g., zero-cost duplicates)
	 */
	private shouldFilterProvider(
		providerName: string,
		providerData: { models?: Record<string, unknown> },
	): boolean {
		// Filter out providers with names that suggest they're coding plans or special variants
		const problematicPatterns = [
			/-coding-plan$/,
			/-special$/,
			/-demo$/,
			/-free$/,
			/-trial$/,
		];

		if (problematicPatterns.some((pattern) => pattern.test(providerName))) {
			this.logger?.debug(
				"Filtering out provider %s due to problematic name pattern",
				providerName,
			);
			return true;
		}

		// Filter out providers that have models with all zero costs
		if (providerData.models) {
			const modelEntries = Object.entries(providerData.models);
			if (modelEntries.length > 0) {
				const allZeroCost = modelEntries.every(([, model]) => {
					if (!model || typeof model !== "object" || !("cost" in model))
						return true;
					const cost = (model as { cost?: unknown }).cost;
					if (!cost || typeof cost !== "object") return true;
					const {
						input = 0,
						output = 0,
						cache_read = 0,
						cache_write = 0,
					} = cost as Record<string, unknown>;
					return (
						input === 0 && output === 0 && cache_read === 0 && cache_write === 0
					);
				});

				if (allZeroCost) {
					this.logger?.debug(
						"Filtering out provider %s because all models have zero cost",
						providerName,
					);
					return true;
				}
			}
		}

		return false;
	}

	private async loadFromCache(): Promise<ApiResponse | null> {
		try {
			const cachePath = this.getCachePath();
			const stats = await fs.stat(cachePath);
			const age = Date.now() - stats.mtime.getTime();

			if (age < this.getCacheDurationMs()) {
				const content = await fs.readFile(cachePath, "utf-8");
				return JSON.parse(content);
			}
		} catch {
			// Cache miss or error - that's ok
		}
		return null;
	}

	private async saveToCache(data: ApiResponse): Promise<void> {
		try {
			await this.ensureCacheDir();
			const cachePath = this.getCachePath();
			await fs.writeFile(cachePath, JSON.stringify(data, null, 2));
		} catch (error) {
			this.logger?.warn("Failed to save pricing cache: %s", error);
		}
	}

	private async fetchRemote(): Promise<ApiResponse | null> {
		if (process.env.CF_PRICING_OFFLINE === "1") {
			return null;
		}

		try {
			const response = await fetch("https://models.dev/api.json");
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			const data = await response.json();
			await this.saveToCache(data);
			return data;
		} catch (error) {
			this.logger?.warn("Failed to fetch pricing data: %s", error);
			return null;
		}
	}

	async getPricing(): Promise<ApiResponse> {
		// Return cached data if available
		if (
			this.priceData &&
			Date.now() - this.lastFetch < this.getCacheDurationMs()
		) {
			return this.priceData;
		}

		// Always attempt to fetch fresh pricing first (once per process start)
		let data = await this.fetchRemote();

		// If remote fetch failed (offline or error), fall back to disk cache
		if (!data) {
			data = await this.loadFromCache();
		}

		// If we have remote data, merge it with bundled pricing to ensure we have all models
		if (data) {
			data = this.mergePricingData(data, BUNDLED_PRICING);
		} else {
			// Fall back to bundled pricing
			data = BUNDLED_PRICING;
		}

		this.priceData = data;
		this.lastFetch = Date.now();
		return data;
	}

	warnOnce(modelId: string, error?: Error | string): void {
		if (!this.warnedModels.has(modelId)) {
			this.warnedModels.add(modelId);
			if (error) {
				this.logger?.warn(
					"Price for model %s not found - cost set to 0 (reason: %s)",
					modelId,
					error instanceof Error ? error.message : error,
				);
			} else {
				this.logger?.warn(
					"Price for model %s not found - cost set to 0",
					modelId,
				);
			}
		}
	}
}

/**
 * Set the logger for pricing warnings
 */
export function setPricingLogger(logger: Logger): void {
	PriceCatalogue.get().setLogger(logger);
}

/**
 * Get the cost rate for a specific model and token type
 * @returns Cost in dollars per token (NOT per million)
 * @throws If model or cost type is unknown
 */
async function getCostRate(
	modelId: string,
	kind: "input" | "output" | "cache_read" | "cache_write",
): Promise<number> {
	const catalogue = PriceCatalogue.get();
	const pricing = await catalogue.getPricing();

	// Search all providers for the model
	for (const provider of Object.values(pricing)) {
		if (provider.models?.[modelId]) {
			const model = provider.models[modelId];
			if (!model.cost) {
				throw new Error(`Model ${modelId} has no cost information`);
			}

			const costKey =
				kind === "cache_read" || kind === "cache_write"
					? kind
					: kind === "input"
						? "input"
						: "output";
			const costPerMillion = model.cost[costKey];

			if (costPerMillion === undefined) {
				throw new Error(`Model ${modelId} has no ${kind} cost`);
			}

			// Convert from per-million to per-token
			return costPerMillion / 1_000_000;
		}
	}

	throw new Error(`Model ${modelId} not found in pricing catalogue`);
}

/**
 * Estimate the total cost in USD for a request based on token counts
 * @returns Cost in dollars (NOT per million)
 */
export async function estimateCostUSD(
	modelId: string,
	tokens: TokenBreakdown,
): Promise<number> {
	const catalogue = PriceCatalogue.get();

	try {
		let totalCost = 0;

		if (tokens.inputTokens) {
			const rate = await getCostRate(modelId, "input");
			totalCost += tokens.inputTokens * rate;
		}

		if (tokens.outputTokens) {
			const rate = await getCostRate(modelId, "output");
			totalCost += tokens.outputTokens * rate;
		}

		if (tokens.cacheReadInputTokens) {
			const rate = await getCostRate(modelId, "cache_read");
			totalCost += tokens.cacheReadInputTokens * rate;
		}

		if (tokens.cacheCreationInputTokens) {
			const rate = await getCostRate(modelId, "cache_write");
			totalCost += tokens.cacheCreationInputTokens * rate;
		}

		return totalCost;
	} catch (error) {
		catalogue.warnOnce(modelId, error instanceof Error ? error : String(error));
		return 0;
	}
}
