import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEYS = [
	"ALERT_DAILY_SPEND_USD",
	"ALERT_TOKENS_PER_HOUR",
	"ALERT_REQUEST_TOKENS",
	"ALERT_ANOMALY_ENABLED",
	"ALERT_ANOMALY_INTERVAL_MINUTES",
	"ALERT_COOLDOWN_MINUTES",
	"ALERT_WEBHOOK_URL",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
	ORIGINAL_ENV[key] = process.env[key];
}

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("alert config settings", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const original = ORIGINAL_ENV[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	it("returns defaults when nothing is configured", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(0);
			expect(config.getAlertTokensPerHour()).toBe(0);
			expect(config.getAlertRequestTokens()).toBe(0);
			expect(config.getAlertAnomalyEnabled()).toBe(false);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(15);
			expect(config.getAlertCooldownMinutes()).toBe(60);
			expect(config.getAlertWebhookUrl()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("honors environment variable overrides", () => {
		process.env.ALERT_DAILY_SPEND_USD = "25.5";
		process.env.ALERT_TOKENS_PER_HOUR = "500000";
		process.env.ALERT_REQUEST_TOKENS = "200000";
		process.env.ALERT_ANOMALY_ENABLED = "true";
		process.env.ALERT_ANOMALY_INTERVAL_MINUTES = "30";
		process.env.ALERT_COOLDOWN_MINUTES = "120";
		process.env.ALERT_WEBHOOK_URL = "https://example.com/hook";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(25.5);
			expect(config.getAlertTokensPerHour()).toBe(500000);
			expect(config.getAlertRequestTokens()).toBe(200000);
			expect(config.getAlertAnomalyEnabled()).toBe(true);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(30);
			expect(config.getAlertCooldownMinutes()).toBe(120);
			expect(config.getAlertWebhookUrl()).toBe("https://example.com/hook");
		} finally {
			cleanup();
		}
	});

	it("treats non-true anomaly env values as disabled", () => {
		process.env.ALERT_ANOMALY_ENABLED = "disabled";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertAnomalyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("clamps out-of-range environment values", () => {
		process.env.ALERT_DAILY_SPEND_USD = "-5";
		process.env.ALERT_TOKENS_PER_HOUR = "9999999999";
		process.env.ALERT_REQUEST_TOKENS = "-100";
		process.env.ALERT_ANOMALY_INTERVAL_MINUTES = "2";
		process.env.ALERT_COOLDOWN_MINUTES = "0";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(0);
			expect(config.getAlertTokensPerHour()).toBe(1_000_000_000);
			expect(config.getAlertRequestTokens()).toBe(0);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(5);
			expect(config.getAlertCooldownMinutes()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("clamps out-of-range config-file values via setters", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertDailySpendUsd(2_000_000);
			expect(config.getAlertDailySpendUsd()).toBe(1_000_000);

			config.setAlertAnomalyIntervalMinutes(3);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(5);

			config.setAlertAnomalyIntervalMinutes(99999);
			expect(config.getAlertAnomalyIntervalMinutes()).toBe(1440);

			config.setAlertCooldownMinutes(0);
			expect(config.getAlertCooldownMinutes()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("persists setter values readable by getters", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertDailySpendUsd(50);
			config.setAlertTokensPerHour(1_000_000);
			config.setAlertRequestTokens(300_000);
			config.setAlertAnomalyEnabled(true);
			config.setAlertCooldownMinutes(45);
			config.setAlertWebhookUrl("https://hooks.example.com/alert");

			expect(config.getAlertDailySpendUsd()).toBe(50);
			expect(config.getAlertTokensPerHour()).toBe(1_000_000);
			expect(config.getAlertRequestTokens()).toBe(300_000);
			expect(config.getAlertAnomalyEnabled()).toBe(true);
			expect(config.getAlertCooldownMinutes()).toBe(45);
			expect(config.getAlertWebhookUrl()).toBe(
				"https://hooks.example.com/alert",
			);
		} finally {
			cleanup();
		}
	});

	it("accepts an empty webhook URL (disabled) and rejects invalid ones", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(() => config.setAlertWebhookUrl("")).not.toThrow();
			expect(config.getAlertWebhookUrl()).toBe("");

			expect(() => config.setAlertWebhookUrl("not-a-url")).toThrow();
			expect(() => config.setAlertWebhookUrl("ftp://example.com")).toThrow();
			expect(() =>
				config.setAlertWebhookUrl("http://example.com/hook"),
			).not.toThrow();
		} finally {
			cleanup();
		}
	});

	it("includes alert settings in getAllSettings()", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			const settings = config.getAllSettings();
			expect(settings.alert_daily_spend_usd).toBe(0);
			expect(settings.alert_tokens_per_hour).toBe(0);
			expect(settings.alert_request_tokens).toBe(0);
			expect(settings.alert_anomaly_enabled).toBe(false);
			expect(settings.alert_anomaly_interval_minutes).toBe(15);
			expect(settings.alert_cooldown_minutes).toBe(60);
			expect(settings.alert_webhook_url).toBe("");
		} finally {
			cleanup();
		}
	});
});
