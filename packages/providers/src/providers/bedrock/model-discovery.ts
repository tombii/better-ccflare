import {
	BedrockClient,
	ListFoundationModelsCommand,
	type FoundationModelSummary,
} from "@aws-sdk/client-bedrock";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { createBedrockCredentialChain, parseBedrockConfig } from "./index";

const log = new Logger("BedrockModelDiscovery");

/**
 * Discovered model information from AWS Bedrock
 */
export interface DiscoveredModel {
	/** Model ID as used in Bedrock API (e.g., "anthropic.claude-opus-4-6-v1:0") */
	modelId: string;
	/** Human-friendly model name (e.g., "Claude Opus 4.6") */
	modelName: string;
	/** Provider name (e.g., "Anthropic") */
	providerName: string;
	/** Input modalities (e.g., ["TEXT"]) */
	inputModalities: string[];
	/** Output modalities (e.g., ["TEXT"]) */
	outputModalities: string[];
	/** Inference types supported (e.g., ["ON_DEMAND"]) */
	inferenceTypesSupported: string[];
	/** Whether streaming is supported */
	responseStreamingSupported: boolean;
}

/**
 * Discover available models in AWS Bedrock account
 *
 * Uses the ListFoundationModels API to retrieve all models available in the
 * configured region for the given account.
 *
 * @param account - Bedrock account with credentials
 * @returns List of discovered models
 * @throws Error if credentials are invalid or API call fails
 */
export async function discoverBedrockModels(
	account: Account,
): Promise<DiscoveredModel[]> {
	const config = parseBedrockConfig(account.custom_endpoint);

	if (!config) {
		throw new Error(
			`Invalid Bedrock config for account ${account.name}: expected format "bedrock:profile:region"`,
		);
	}

	const credentials = createBedrockCredentialChain(account);
	const client = new BedrockClient({
		region: config.region,
		credentials,
	});

	try {
		log.info(
			`Discovering models for account ${account.name} in region ${config.region}`,
		);

		const command = new ListFoundationModelsCommand({
			// Filter to only Claude models from Anthropic
			byProvider: "Anthropic",
		});

		const response = await client.send(command);

		if (!response.modelSummaries || response.modelSummaries.length === 0) {
			log.warn(`No models found for account ${account.name}`);
			return [];
		}

		const models: DiscoveredModel[] = response.modelSummaries
			.filter((model): model is FoundationModelSummary => !!model.modelId)
			.map((model) => ({
				modelId: model.modelId!,
				modelName: model.modelName || model.modelId!,
				providerName: model.providerName || "Unknown",
				inputModalities: model.inputModalities || [],
				outputModalities: model.outputModalities || [],
				inferenceTypesSupported: model.inferenceTypesSupported || [],
				responseStreamingSupported: model.responseStreamingSupported ?? false,
			}));

		log.info(
			`Discovered ${models.length} Anthropic models for account ${account.name}`,
		);

		return models;
	} catch (error) {
		log.error(
			`Failed to discover models for account ${account.name}: ${(error as Error).message}`,
		);
		throw error;
	}
}

/**
 * Generate client-friendly model name from Bedrock model ID
 *
 * Converts Bedrock format to standard Claude API format:
 * - "anthropic.claude-opus-4-6-v1:0" → "claude-opus-4-6"
 * - "anthropic.claude-3-5-sonnet-20241022-v2:0" → "claude-3-5-sonnet-20241022"
 *
 * @param bedrockModelId - Full Bedrock model ID
 * @returns Client-friendly model name
 */
export function generateClientModelName(bedrockModelId: string): string {
	// Remove provider prefix (e.g., "anthropic.")
	let modelName = bedrockModelId.replace(/^[^.]+\./, "");

	// Remove version suffix (e.g., "-v1:0", "-v2:0")
	modelName = modelName.replace(/-v\d+:\d+$/, "");

	return modelName;
}

/**
 * Discover models and generate model translation suggestions
 *
 * Returns both the Bedrock model ID and a suggested client-friendly name
 * that can be used to populate the model_translations table.
 *
 * @param account - Bedrock account with credentials
 * @returns Map of client names to Bedrock model IDs
 */
export async function generateModelTranslations(
	account: Account,
): Promise<Map<string, string>> {
	const models = await discoverBedrockModels(account);
	const translations = new Map<string, string>();

	for (const model of models) {
		const clientName = generateClientModelName(model.modelId);
		translations.set(clientName, model.modelId);
	}

	return translations;
}
