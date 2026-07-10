import { describe, expect, it, mock } from "bun:test";
import type { APIContext } from "@better-ccflare/types";
import { createConfigHandlers } from "../config";

function makeCatalog(
	models: string[],
	source: "live" | "fallback" = "live",
): APIContext["modelCatalog"] {
	return {
		get: async () => ({
			models: models.map((id) => ({ id, displayName: id, createdAt: null })),
			fetchedAt: Date.now(),
			source,
		}),
		refresh: async () => ({ success: true }),
	};
}

function makeConfig() {
	return {
		getAllSettings: () => ({
			lb_strategy: "session",
			port: 8080,
			sessionDurationMs: 18_000_000,
			default_agent_model: "sonnet",
			system_prompt_cache_ttl_1h: false,
			usage_throttling_five_hour_enabled: true,
			usage_throttling_weekly_enabled: true,
		}),
		getSystemPromptCacheTtl1h: () => false,
		getUsageThrottlingFiveHourEnabled: () => true,
		getUsageThrottlingWeeklyEnabled: () => true,
		setUsageThrottlingFiveHourEnabled: mock(() => {}),
		setUsageThrottlingWeeklyEnabled: mock(() => {}),
		getStrategy: () => "session",
		setStrategy: mock(() => {}),
		getDefaultAgentModel: () => "sonnet",
		setDefaultAgentModel: mock(() => {}),
		getDataRetentionDays: () => 3,
		getRequestRetentionDays: () => 90,
		getStorePayloads: () => true,
		setDataRetentionDays: mock(() => {}),
		setRequestRetentionDays: mock(() => {}),
		setStorePayloads: mock(() => {}),
		getCacheKeepaliveTtlMinutes: () => 0,
		setCacheKeepaliveTtlMinutes: mock(() => {}),
		setSystemPromptCacheTtl1h: mock(() => {}),
	} as unknown as import("@better-ccflare/config").Config;
}

describe("createConfigHandlers", () => {
	it("includes per-window usage throttling flags in config payload", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getConfig();
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.usage_throttling_five_hour_enabled).toBe(true);
		expect(body.usage_throttling_weekly_enabled).toBe(true);
	});

	it("updates usage throttling windows from POST body", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setUsageThrottling(
			new Request("http://localhost/api/config/usage-throttling", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					fiveHourEnabled: false,
					weeklyEnabled: true,
				}),
			}),
		);

		expect(response.status).toBe(204);
		expect(config.setUsageThrottlingFiveHourEnabled).toHaveBeenCalledWith(
			false,
		);
		expect(config.setUsageThrottlingWeeklyEnabled).toHaveBeenCalledWith(true);
	});

	it("rejects a default agent model without a recognized Claude family substring", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "totally-not-a-claude-model" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setDefaultAgentModel).not.toHaveBeenCalled();
	});

	it("accepts a valid Claude model as the default agent model", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-sonnet-5" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(config.setDefaultAgentModel).toHaveBeenCalledWith("claude-sonnet-5");
	});

	it("accepts a non-pattern model id present in a live catalog", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(
			config,
			{ port: 8080, tlsEnabled: false },
			makeCatalog(["claude-nova-9"]),
		);

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(200);
		expect(config.setDefaultAgentModel).toHaveBeenCalledWith("claude-nova-9");
	});

	it("rejects a non-pattern model id absent from a fallback catalog with 400", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(
			config,
			{ port: 8080, tlsEnabled: false },
			makeCatalog(["claude-nova-9"], "fallback"),
		);

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setDefaultAgentModel).not.toHaveBeenCalled();
	});

	it("rejects a non-pattern model id with 400 when no catalog is injected", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setDefaultAgentModel(
			new Request("http://localhost/api/config/model", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "claude-nova-9" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setDefaultAgentModel).not.toHaveBeenCalled();
	});
});
