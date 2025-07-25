import type { Database } from "bun:sqlite";
import {
	isValidStrategy,
	type StrategyName,
	DEFAULT_STRATEGY,
} from "./strategy";

export interface RuntimeConfig {
	clientId: string;
	retry: { attempts: number; delayMs: number; backoff: number };
	sessionDurationMs: number;
	port: number;
}

export class Config {
	private db: Database;
	// biome-ignore lint/suspicious/noExplicitAny: Config values can be of any type
	private cache: Map<string, any> = new Map();

	constructor(db: Database) {
		this.db = db;
		this.initializeConfigTable();
		this.loadCache();
	}

	private initializeConfigTable(): void {
		this.db.run(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
	}

	private loadCache(): void {
		const configs = this.db
			.query("SELECT key, value FROM config")
			.all() as Array<{
			key: string;
			value: string;
		}>;

		for (const config of configs) {
			try {
				this.cache.set(config.key, JSON.parse(config.value));
			} catch {
				this.cache.set(config.key, config.value);
			}
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Config system needs to support any value type
	get(key: string, defaultValue?: any): any {
		if (this.cache.has(key)) {
			return this.cache.get(key);
		}

		const result = this.db
			.query("SELECT value FROM config WHERE key = ?")
			.get(key) as { value: string } | undefined;

		if (!result) {
			if (defaultValue !== undefined) {
				this.set(key, defaultValue);
				return defaultValue;
			}
			return null;
		}

		try {
			const value = JSON.parse(result.value);
			this.cache.set(key, value);
			return value;
		} catch {
			this.cache.set(key, result.value);
			return result.value;
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Config system needs to support any value type
	set(key: string, value: any): void {
		const serialized =
			typeof value === "string" ? value : JSON.stringify(value);

		this.db.run(
			`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)`,
			[key, serialized, Date.now()],
		);

		this.cache.set(key, value);
	}

	getStrategy(): StrategyName {
		// First check environment variable
		const envStrategy = process.env.LB_STRATEGY;
		if (envStrategy && isValidStrategy(envStrategy)) {
			return envStrategy;
		}

		// Then check database config
		const dbStrategy = this.get("lb_strategy", DEFAULT_STRATEGY);
		if (isValidStrategy(dbStrategy)) {
			return dbStrategy;
		}

		return DEFAULT_STRATEGY;
	}

	setStrategy(strategy: StrategyName): void {
		if (!isValidStrategy(strategy)) {
			throw new Error(`Invalid strategy: ${strategy}`);
		}
		this.set("lb_strategy", strategy);
	}

	// biome-ignore lint/suspicious/noExplicitAny: Config values can be of any type
	getAllSettings(): Record<string, any> {
		// biome-ignore lint/suspicious/noExplicitAny: Config values can be of any type
		const settings: Record<string, any> = {};
		const configs = this.db
			.query("SELECT key, value FROM config")
			.all() as Array<{
			key: string;
			value: string;
		}>;

		for (const config of configs) {
			try {
				settings[config.key] = JSON.parse(config.value);
			} catch {
				settings[config.key] = config.value;
			}
		}

		// Include current strategy (which might come from env)
		settings.lb_strategy = this.getStrategy();

		return settings;
	}

	getRuntime(): RuntimeConfig {
		// Default values
		const defaults: RuntimeConfig = {
			clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			retry: {
				attempts: 3,
				delayMs: 1000,
				backoff: 2,
			},
			sessionDurationMs: 5 * 60 * 60 * 1000, // 5 hours
			port: 8080,
		};

		// Override with environment variables if present
		if (process.env.CLIENT_ID) {
			defaults.clientId = process.env.CLIENT_ID;
		}
		if (process.env.RETRY_ATTEMPTS) {
			defaults.retry.attempts = parseInt(process.env.RETRY_ATTEMPTS);
		}
		if (process.env.RETRY_DELAY_MS) {
			defaults.retry.delayMs = parseInt(process.env.RETRY_DELAY_MS);
		}
		if (process.env.RETRY_BACKOFF) {
			defaults.retry.backoff = parseFloat(process.env.RETRY_BACKOFF);
		}
		if (process.env.SESSION_DURATION_MS) {
			defaults.sessionDurationMs = parseInt(process.env.SESSION_DURATION_MS);
		}
		if (process.env.PORT) {
			defaults.port = parseInt(process.env.PORT);
		}

		// Override with database settings if present
		const dbClientId = this.get("client_id");
		if (dbClientId) defaults.clientId = dbClientId;

		const dbRetryAttempts = this.get("retry_attempts");
		if (dbRetryAttempts) defaults.retry.attempts = dbRetryAttempts;

		const dbRetryDelayMs = this.get("retry_delay_ms");
		if (dbRetryDelayMs) defaults.retry.delayMs = dbRetryDelayMs;

		const dbRetryBackoff = this.get("retry_backoff");
		if (dbRetryBackoff) defaults.retry.backoff = dbRetryBackoff;

		const dbSessionDurationMs = this.get("session_duration_ms");
		if (dbSessionDurationMs) defaults.sessionDurationMs = dbSessionDurationMs;

		const dbPort = this.get("port");
		if (dbPort) defaults.port = dbPort;

		return defaults;
	}
}
