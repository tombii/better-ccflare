import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
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
		return this.config.baseUrl || "https://api.anthropic.com";
	}

	/**
	 * Build target URL for Anthropic-compatible endpoint
	 * @param pathname - The pathname from the original request
	 * @param search - The search string from the original request
	 * @param account - The account configuration (for custom endpoints)
	 * @returns The complete target URL
	 */
	buildUrl(pathname: string, search: string, account?: Account): string {
		// Use custom endpoint from account if available, otherwise fall back to config
		const baseUrl = account?.custom_endpoint || this.getEndpoint();
		const cleanBaseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
		return `${cleanBaseUrl}${pathname}${search}`;
	}

	/**
	 * Update the configuration
	 */
	updateConfig(newConfig: Partial<AnthropicCompatibleConfig>): void {
		this.config = { ...this.config, ...newConfig };
		this.name =
			this.config.name || DEFAULT_CONFIG.name || "anthropic-compatible";
		if (!this.config.name) {
			this.config.name = DEFAULT_CONFIG.name || "anthropic-compatible";
		}
	}

	/**
	 * Get the current configuration
	 */
	getConfig(): AnthropicCompatibleConfig {
		return { ...this.config };
	}
}
