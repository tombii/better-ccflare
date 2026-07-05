import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	DEFAULT_AGENT_MODEL,
	DEFAULT_STRATEGY,
	isValidStrategy,
	NETWORK,
	type StrategyName,
	TIME_CONSTANTS,
	ValidationError,
	validateNumber,
	validateString,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { validatePathOrThrow } from "@better-ccflare/security";
import { resolveConfigPath } from "./paths";

const log = new Logger("Config");

function parseEnabledEnvFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return value === "true" || value === "1";
}

export interface RuntimeConfig {
	clientId: string;
	retry: { attempts: number; delayMs: number; backoff: number };
	sessionDurationMs: number;
	port: number;
	database?: {
		walMode?: boolean;
		busyTimeoutMs?: number;
		cacheSize?: number;
		synchronous?: "OFF" | "NORMAL" | "FULL";
		mmapSize?: number;
		pageSize?: number;
		retry?: {
			attempts?: number;
			delayMs?: number;
			backoff?: number;
			maxDelayMs?: number;
		};
	};
}

export interface ConfigData {
	lb_strategy?: StrategyName;
	client_id?: string;
	retry_attempts?: number;
	retry_delay_ms?: number;
	retry_backoff?: number;
	session_duration_ms?: number;
	port?: number;
	default_agent_model?: string;
	data_retention_days?: number;
	request_retention_days?: number;
	usage_history_retention_days?: number;
	store_payloads?: boolean;
	usage_poll_interval_ms?: number;
	cache_keepalive_ttl_minutes?: number;
	system_prompt_cache_ttl_1h?: boolean;
	usage_throttling_five_hour_enabled?: boolean;
	usage_throttling_weekly_enabled?: boolean;
	health_detail_enabled?: boolean;
	alert_daily_spend_usd?: number;
	alert_tokens_per_hour?: number;
	alert_request_tokens?: number;
	alert_anomaly_enabled?: boolean;
	alert_anomaly_interval_minutes?: number;
	alert_cooldown_minutes?: number;
	alert_webhook_url?: string;
	// Database configuration
	db_wal_mode?: boolean;
	db_busy_timeout_ms?: number;
	db_cache_size?: number;
	db_synchronous?: "OFF" | "NORMAL" | "FULL";
	db_mmap_size?: number;
	db_page_size?: number;
	db_retry_attempts?: number;
	db_retry_delay_ms?: number;
	db_retry_backoff?: number;
	db_retry_max_delay_ms?: number;
	[key: string]: string | number | boolean | undefined;
}

/**
 * Validates database configuration parameters
 */
function validateDatabaseConfig(
	config: Partial<RuntimeConfig["database"]>,
): void {
	if (!config) return;

	// Validate synchronous mode
	if (config.synchronous !== undefined) {
		validateString(config.synchronous, "db_synchronous", {
			allowedValues: ["OFF", "NORMAL", "FULL"],
		});
	}

	// Validate numeric parameters with reasonable bounds
	if (config.busyTimeoutMs !== undefined) {
		validateNumber(config.busyTimeoutMs, "db_busy_timeout_ms", {
			min: 0,
			max: 300000, // 5 minutes max
			integer: true,
		});
	}

	if (config.cacheSize !== undefined) {
		validateNumber(config.cacheSize, "db_cache_size", {
			min: -2000000, // -2GB max negative (KB)
			max: 1000000, // 1M pages max positive
			integer: true,
		});
	}

	if (config.mmapSize !== undefined) {
		validateNumber(config.mmapSize, "db_mmap_size", {
			min: 0,
			max: 1073741824, // 1GB max
			integer: true,
		});
	}

	// Validate retry configuration consistency
	if (config.retry) {
		const retry = config.retry;

		if (retry.attempts !== undefined) {
			validateNumber(retry.attempts, "db_retry_attempts", {
				min: 1,
				max: 10,
				integer: true,
			});
		}

		if (retry.delayMs !== undefined) {
			validateNumber(retry.delayMs, "db_retry_delay_ms", {
				min: 1,
				max: 60000, // 1 minute max
				integer: true,
			});
		}

		if (retry.backoff !== undefined) {
			validateNumber(retry.backoff, "db_retry_backoff", {
				min: 1,
				max: 10,
			});
		}

		if (retry.maxDelayMs !== undefined) {
			validateNumber(retry.maxDelayMs, "db_retry_max_delay_ms", {
				min: 1,
				max: 300000, // 5 minutes max
				integer: true,
			});
		}

		// Ensure maxDelayMs is greater than delayMs if both are specified
		if (retry.delayMs !== undefined && retry.maxDelayMs !== undefined) {
			if (retry.maxDelayMs < retry.delayMs) {
				throw new ValidationError(
					"db_retry_max_delay_ms must be greater than or equal to db_retry_delay_ms",
					"db_retry_max_delay_ms",
				);
			}
		}
	}
}

export class Config extends EventEmitter {
	private configPath: string;
	private data: ConfigData = {};

	constructor(configPath?: string) {
		super();
		const rawPath = configPath ?? resolveConfigPath();
		// Validate config path for security
		this.configPath = validatePathOrThrow(rawPath, {
			description: "config file",
		});
		this.loadConfig();
	}

	private loadConfig(): void {
		if (existsSync(this.configPath)) {
			try {
				const content = readFileSync(this.configPath, "utf8");
				this.data = JSON.parse(content) as ConfigData;
			} catch (error) {
				log.error(`Failed to parse config file: ${error}`);
				this.data = {};
			}
		} else {
			// Create config directory if it doesn't exist
			const dir = dirname(this.configPath);
			mkdirSync(dir, { recursive: true });

			// Initialize with default config
			this.data = {
				lb_strategy: DEFAULT_STRATEGY,
			};
			this.saveConfig();
		}
	}

	private saveConfig(): void {
		try {
			const content = JSON.stringify(this.data, null, 2);
			writeFileSync(this.configPath, content, "utf8");
		} catch (error) {
			log.error(`Failed to save config file: ${error}`);
		}
	}

	get(
		key: string,
		defaultValue?: string | number | boolean,
	): string | number | boolean | undefined {
		if (key in this.data) {
			return this.data[key];
		}

		if (defaultValue !== undefined) {
			this.set(key, defaultValue);
			return defaultValue;
		}

		return undefined;
	}

	set(key: string, value: string | number | boolean): void {
		const oldValue = this.data[key];
		this.data[key] = value;
		this.saveConfig();

		// Emit change event
		this.emit("change", { key, oldValue, newValue: value });
	}

	getStrategy(): StrategyName {
		// First check environment variable
		const envStrategy = process.env.LB_STRATEGY;
		if (envStrategy && isValidStrategy(envStrategy)) {
			return envStrategy;
		}

		// Then check config file
		const configStrategy = this.data.lb_strategy;
		if (configStrategy && isValidStrategy(configStrategy)) {
			return configStrategy;
		}

		return DEFAULT_STRATEGY;
	}

	setStrategy(strategy: StrategyName): void {
		if (!isValidStrategy(strategy)) {
			throw new Error(`Invalid strategy: ${strategy}`);
		}
		this.set("lb_strategy", strategy);
	}

	getDefaultAgentModel(): string {
		// First check environment variable
		const envModel = process.env.DEFAULT_AGENT_MODEL;
		if (envModel) {
			return envModel;
		}

		// Then check config file
		const configModel = this.data.default_agent_model;
		if (configModel) {
			return configModel;
		}

		// Default to the centralized default agent model
		return DEFAULT_AGENT_MODEL;
	}

	setDefaultAgentModel(model: string): void {
		this.set("default_agent_model", model);
	}

	private clamp(n: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, n));
	}

	getDataRetentionDays(): number {
		const fromEnv = process.env.DATA_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 365);
		}
		const fromFile = this.data.data_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 365);
		// Default payload retention reduced to 1 day to bound request_payloads
		// growth: each request stores up to ~4 MiB of conversation history, so
		// high-volume proxies otherwise reach tens of GB. Override via the
		// DATA_RETENTION_DAYS env var or the data_retention_days config key.
		return 1;
	}

	setDataRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 365);
		this.set("data_retention_days", clamped);
	}

	getRequestRetentionDays(): number {
		const fromEnv = process.env.REQUEST_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.request_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 90; // default metadata retention (90 days for analytics and troubleshooting)
	}

	setRequestRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("request_retention_days", clamped);
	}

	getUsageHistoryRetentionDays(): number {
		const fromEnv = process.env.USAGE_HISTORY_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.usage_history_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 90; // default: keep 90 days of usage-window history
	}

	setUsageHistoryRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("usage_history_retention_days", clamped);
	}

	getStorePayloads(): boolean {
		const fromEnv = process.env.STORE_PAYLOADS;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.store_payloads;
		if (typeof fromFile === "boolean") return fromFile;
		return true; // default: store payloads
	}

	setStorePayloads(value: boolean): void {
		this.set("store_payloads", value);
	}

	getUsagePollIntervalMs(): number {
		const fromEnv = process.env.USAGE_POLL_INTERVAL_MS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 10000, 3600000);
		}
		const fromFile = this.data.usage_poll_interval_ms;
		if (typeof fromFile === "number")
			return this.clamp(fromFile, 10000, 3600000);
		return 90000; // default: 90 seconds
	}

	setUsagePollIntervalMs(ms: number): void {
		const clamped = this.clamp(ms, 10000, 3600000);
		this.set("usage_poll_interval_ms", clamped);
	}

	getCacheKeepaliveTtlMinutes(): number {
		const fromEnv = process.env.CACHE_KEEPALIVE_TTL_MINUTES;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 60);
		}
		const fromFile = this.data.cache_keepalive_ttl_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 60);
		return 0; // default: disabled
	}

	setCacheKeepaliveTtlMinutes(minutes: number): void {
		const clamped = this.clamp(minutes, 0, 60);
		this.set("cache_keepalive_ttl_minutes", clamped);
	}

	getSystemPromptCacheTtl1h(): boolean {
		const fromEnv = process.env.SYSTEM_PROMPT_CACHE_TTL_1H;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.system_prompt_cache_ttl_1h;
		if (typeof fromFile === "boolean") return fromFile;
		return false; // default: disabled
	}

	setSystemPromptCacheTtl1h(value: boolean): void {
		this.set("system_prompt_cache_ttl_1h", value);
	}

	getUsageThrottlingFiveHourEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.USAGE_THROTTLING_FIVE_HOUR_ENABLED,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.usage_throttling_five_hour_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	getUsageThrottlingWeeklyEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.USAGE_THROTTLING_WEEKLY_ENABLED,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.usage_throttling_weekly_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	setUsageThrottlingFiveHourEnabled(value: boolean): void {
		this.set("usage_throttling_five_hour_enabled", value);
	}

	setUsageThrottlingWeeklyEnabled(value: boolean): void {
		this.set("usage_throttling_weekly_enabled", value);
	}

	getHealthDetailEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(process.env.HEALTH_DETAIL_ENABLED);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.health_detail_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	getAlertDailySpendUsd(): number {
		const fromEnv = process.env.ALERT_DAILY_SPEND_USD;
		if (fromEnv) {
			const n = Number.parseFloat(fromEnv);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000);
		}
		const fromFile = this.data.alert_daily_spend_usd;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 1_000_000);
		return 0;
	}

	setAlertDailySpendUsd(value: number): void {
		this.set("alert_daily_spend_usd", this.clamp(value, 0, 1_000_000));
	}

	getAlertTokensPerHour(): number {
		const fromEnv = process.env.ALERT_TOKENS_PER_HOUR;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000_000);
		}
		const fromFile = this.data.alert_tokens_per_hour;
		if (typeof fromFile === "number") {
			return this.clamp(fromFile, 0, 1_000_000_000);
		}
		return 0;
	}

	setAlertTokensPerHour(value: number): void {
		this.set("alert_tokens_per_hour", this.clamp(value, 0, 1_000_000_000));
	}

	getAlertRequestTokens(): number {
		const fromEnv = process.env.ALERT_REQUEST_TOKENS;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000_000);
		}
		const fromFile = this.data.alert_request_tokens;
		if (typeof fromFile === "number") {
			return this.clamp(fromFile, 0, 1_000_000_000);
		}
		return 0;
	}

	setAlertRequestTokens(value: number): void {
		this.set("alert_request_tokens", this.clamp(value, 0, 1_000_000_000));
	}

	getAlertAnomalyEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(process.env.ALERT_ANOMALY_ENABLED);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.alert_anomaly_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	setAlertAnomalyEnabled(value: boolean): void {
		this.set("alert_anomaly_enabled", value);
	}

	getAlertAnomalyIntervalMinutes(): number {
		const fromEnv = process.env.ALERT_ANOMALY_INTERVAL_MINUTES;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 5, 1440);
		}
		const fromFile = this.data.alert_anomaly_interval_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 5, 1440);
		return 15;
	}

	setAlertAnomalyIntervalMinutes(value: number): void {
		this.set("alert_anomaly_interval_minutes", this.clamp(value, 5, 1440));
	}

	getAlertCooldownMinutes(): number {
		const fromEnv = process.env.ALERT_COOLDOWN_MINUTES;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 1440);
		}
		const fromFile = this.data.alert_cooldown_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 1440);
		return 60;
	}

	setAlertCooldownMinutes(value: number): void {
		this.set("alert_cooldown_minutes", this.clamp(value, 1, 1440));
	}

	getAlertWebhookUrl(): string {
		const fromEnv = process.env.ALERT_WEBHOOK_URL;
		if (fromEnv !== undefined) return fromEnv;
		const fromFile = this.data.alert_webhook_url;
		if (typeof fromFile === "string") return fromFile;
		return "";
	}

	setAlertWebhookUrl(value: string): void {
		if (value !== "") {
			let parsed: URL;
			try {
				parsed = new URL(value);
			} catch (_error) {
				throw new ValidationError(
					"Invalid alert webhook URL",
					"alert_webhook_url",
				);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new ValidationError(
					"Invalid alert webhook URL",
					"alert_webhook_url",
				);
			}
		}
		this.set("alert_webhook_url", value);
	}

	getAllSettings(): Record<string, string | number | boolean | undefined> {
		// Include current strategy (which might come from env)
		return {
			...this.data,
			lb_strategy: this.getStrategy(),
			default_agent_model: this.getDefaultAgentModel(),
			data_retention_days: this.getDataRetentionDays(),
			request_retention_days: this.getRequestRetentionDays(),
			usage_history_retention_days: this.getUsageHistoryRetentionDays(),
			store_payloads: this.getStorePayloads(),
			usage_poll_interval_ms: this.getUsagePollIntervalMs(),
			cache_keepalive_ttl_minutes: this.getCacheKeepaliveTtlMinutes(),
			system_prompt_cache_ttl_1h: this.getSystemPromptCacheTtl1h(),
			usage_throttling_five_hour_enabled:
				this.getUsageThrottlingFiveHourEnabled(),
			usage_throttling_weekly_enabled: this.getUsageThrottlingWeeklyEnabled(),
			health_detail_enabled: this.getHealthDetailEnabled(),
			alert_daily_spend_usd: this.getAlertDailySpendUsd(),
			alert_tokens_per_hour: this.getAlertTokensPerHour(),
			alert_request_tokens: this.getAlertRequestTokens(),
			alert_anomaly_enabled: this.getAlertAnomalyEnabled(),
			alert_anomaly_interval_minutes: this.getAlertAnomalyIntervalMinutes(),
			alert_cooldown_minutes: this.getAlertCooldownMinutes(),
			alert_webhook_url: this.getAlertWebhookUrl(),
		};
	}

	getRuntime(): RuntimeConfig {
		// Default values
		const defaults: RuntimeConfig = {
			clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			retry: {
				attempts: 3,
				delayMs: TIME_CONSTANTS.RETRY_DELAY_DEFAULT,
				backoff: 2,
			},
			sessionDurationMs: TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
			port: NETWORK.DEFAULT_PORT,
			database: {
				walMode: true,
				busyTimeoutMs: 5000,
				cacheSize: -20000, // 20MB cache
				synchronous: "NORMAL",
				mmapSize: 268435456, // 256MB
				retry: {
					attempts: 3,
					delayMs: 100,
					backoff: 2,
					maxDelayMs: 5000,
				},
			},
		};

		// Override with environment variables if present
		if (process.env.CLIENT_ID) {
			defaults.clientId = process.env.CLIENT_ID;
		}
		if (process.env.RETRY_ATTEMPTS) {
			defaults.retry.attempts = parseInt(process.env.RETRY_ATTEMPTS, 10);
		}
		if (process.env.RETRY_DELAY_MS) {
			defaults.retry.delayMs = parseInt(process.env.RETRY_DELAY_MS, 10);
		}
		if (process.env.RETRY_BACKOFF) {
			defaults.retry.backoff = parseFloat(process.env.RETRY_BACKOFF);
		}
		if (process.env.SESSION_DURATION_MS) {
			defaults.sessionDurationMs = parseInt(
				process.env.SESSION_DURATION_MS,
				10,
			);
		}
		if (process.env.PORT) {
			defaults.port = parseInt(process.env.PORT, 10);
		}

		// Override with config file settings if present
		if (this.data.client_id) {
			defaults.clientId = this.data.client_id;
		}
		if (typeof this.data.retry_attempts === "number") {
			defaults.retry.attempts = this.data.retry_attempts;
		}
		if (typeof this.data.retry_delay_ms === "number") {
			defaults.retry.delayMs = this.data.retry_delay_ms;
		}
		if (typeof this.data.retry_backoff === "number") {
			defaults.retry.backoff = this.data.retry_backoff;
		}
		if (typeof this.data.session_duration_ms === "number") {
			defaults.sessionDurationMs = this.data.session_duration_ms;
		}
		if (typeof this.data.port === "number") {
			defaults.port = this.data.port;
		}

		// Database configuration overrides
		// Ensure database configuration object exists
		if (!defaults.database) {
			defaults.database = {
				walMode: true,
				busyTimeoutMs: 5000,
				cacheSize: -20000,
				synchronous: "NORMAL",
				mmapSize: 268435456,
				retry: {
					attempts: 3,
					delayMs: 100,
					backoff: 2,
					maxDelayMs: 5000,
				},
			};
		}

		// Ensure retry configuration object exists
		if (!defaults.database.retry) {
			defaults.database.retry = {
				attempts: 3,
				delayMs: 100,
				backoff: 2,
				maxDelayMs: 5000,
			};
		}

		if (typeof this.data.db_wal_mode === "boolean") {
			defaults.database.walMode = this.data.db_wal_mode;
		}
		if (typeof this.data.db_busy_timeout_ms === "number") {
			defaults.database.busyTimeoutMs = this.data.db_busy_timeout_ms;
		}
		if (typeof this.data.db_cache_size === "number") {
			defaults.database.cacheSize = this.data.db_cache_size;
		}
		if (typeof this.data.db_synchronous === "string") {
			defaults.database.synchronous = this.data.db_synchronous as
				| "OFF"
				| "NORMAL"
				| "FULL";
		}
		if (typeof this.data.db_mmap_size === "number") {
			defaults.database.mmapSize = this.data.db_mmap_size;
		}
		// Page size: default 2048 (2KB) for better memory efficiency, recommend 4096 (4KB)
		if (typeof this.data.db_page_size === "number") {
			defaults.database.pageSize = this.data.db_page_size;
		} else {
			defaults.database.pageSize = 2048;
		}
		if (typeof this.data.db_retry_attempts === "number") {
			defaults.database.retry.attempts = this.data.db_retry_attempts;
		}
		if (typeof this.data.db_retry_delay_ms === "number") {
			defaults.database.retry.delayMs = this.data.db_retry_delay_ms;
		}
		if (typeof this.data.db_retry_backoff === "number") {
			defaults.database.retry.backoff = this.data.db_retry_backoff;
		}
		if (typeof this.data.db_retry_max_delay_ms === "number") {
			defaults.database.retry.maxDelayMs = this.data.db_retry_max_delay_ms;
		}

		// Validate the final database configuration
		try {
			validateDatabaseConfig(defaults.database);
		} catch (error) {
			if (error instanceof ValidationError) {
				log.error(`Database configuration validation failed: ${error.message}`);
				throw error;
			}
			throw error;
		}

		return defaults;
	}
}

// Re-export types
export type { StrategyName } from "@better-ccflare/core";
export { resolveConfigPath } from "./paths";
export { getLegacyConfigDir, getPlatformConfigDir } from "./paths-common";
