import type { Config } from "./index";

/**
 * Type-safe configuration accessor to reduce repetitive config access patterns
 */
export class ConfigAccessor {
	constructor(private config: Config) {}

	get port(): number {
		return (this.config.getAllSettings().port as number) || 8080;
	}

	get strategy(): string {
		return this.config.getStrategy();
	}

	get sessionDurationMs(): number {
		return (this.config.getAllSettings().sessionDurationMs as number) || 5 * 60 * 60 * 1000;
	}

	get dbPath(): string | undefined {
		return this.config.getAllSettings().dbPath as string | undefined;
	}

	get logLevel(): string {
		return (this.config.getAllSettings().logLevel as string) || "info";
	}

	get enableMetrics(): boolean {
		return (this.config.getAllSettings().enableMetrics as boolean) || false;
	}

	/**
	 * Get all settings with proper typing
	 */
	getAllTyped(): {
		port: number;
		strategy: string;
		sessionDurationMs: number;
		dbPath?: string;
		logLevel: string;
		enableMetrics: boolean;
	} {
		const settings = this.config.getAllSettings();
		return {
			port: this.port,
			strategy: this.strategy,
			sessionDurationMs: this.sessionDurationMs,
			dbPath: this.dbPath,
			logLevel: this.logLevel,
			enableMetrics: this.enableMetrics,
		};
	}

	/**
	 * Update multiple settings at once
	 */
	updateSettings(updates: Partial<{
		port: number;
		strategy: string;
		sessionDurationMs: number;
		dbPath: string;
		logLevel: string;
		enableMetrics: boolean;
	}>): void {
		if (updates.strategy) {
			this.config.setStrategy(updates.strategy as any);
		}
		// Add other setters as needed
	}
}