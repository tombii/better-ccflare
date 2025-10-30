import { Logger } from "@better-ccflare/logger";
import {
	type AnthropicCompatibleConfig,
	BaseAnthropicCompatibleProvider,
} from "../base-anthropic-compatible";

const _log = new Logger("AnthropicCompatibleProvider");

// Re-export the config type
export type { AnthropicCompatibleConfig };

// Default configuration
const DEFAULT_CONFIG: Partial<AnthropicCompatibleConfig> = {
	name: "anthropic-compatible",
	baseUrl:
		process.env.ANTHROPIC_COMPATIBLE_BASE_URL || "https://api.anthropic.com",
	authHeader: "x-api-key",
	authType: "direct",
	supportsStreaming: true,
};

export class AnthropicCompatibleProvider extends BaseAnthropicCompatibleProvider {
	constructor(config: Partial<AnthropicCompatibleConfig> = {}) {
		super({ ...DEFAULT_CONFIG, ...config });
	}

	getEndpoint(): string {
		// Use the configured base URL for this generic provider
		return this.config.baseUrl!;
	}

	/**
	 * Update the configuration
	 */
	updateConfig(newConfig: Partial<AnthropicCompatibleConfig>): void {
		this.config = { ...this.config, ...newConfig };
		this.name = this.config.name! || DEFAULT_CONFIG.name!;
		if (!this.config.name) {
			this.config.name = DEFAULT_CONFIG.name!;
		}
	}

	/**
	 * Get the current configuration
	 */
	getConfig(): AnthropicCompatibleConfig {
		return { ...this.config };
	}
}
