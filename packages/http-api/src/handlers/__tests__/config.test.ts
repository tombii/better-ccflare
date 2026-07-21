import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
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
		getModelScopedCapacityRouting: () => "off" as const,
		getModelScopedCapacityRoutingSource: () => "default" as const,
		setModelScopedCapacityRouting: mock(() => {}),
		getStrategy: () => "session",
		getStrategySource: () => "default" as const,
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

	it("reports the current strategy with its source", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getStrategy();
		const body = (await response.json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(body.strategy).toBe("session");
		expect(body.strategySource).toBe("default");
	});

	it("reports the current model capacity routing mode with its source", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = handlers.getModelCapacityRouting();
		const body = (await response.json()) as { mode: string; source: string };
		expect(body.mode).toBe("off");
		expect(body.source).toBe("default");
	});

	it("updates the model capacity routing mode from POST body (200 + echo)", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setModelCapacityRouting(
			new Request("http://localhost/api/config/model-capacity-routing", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "exhausted" }),
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			mode: string;
		};
		expect(body.success).toBe(true);
		expect(body.mode).toBe("exhausted");
		expect(config.setModelScopedCapacityRouting).toHaveBeenCalledWith(
			"exhausted",
		);
	});

	it("rejects an invalid model capacity routing mode with 400", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setModelCapacityRouting(
			new Request("http://localhost/api/config/model-capacity-routing", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "always" }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setModelScopedCapacityRouting).not.toHaveBeenCalled();
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

describe("model capacity routing source & effective mode (real config)", () => {
	const originalEnv = process.env.MODEL_SCOPED_CAPACITY_ROUTING;
	const tmpDirs: string[] = [];

	function realConfig(): Config {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-handler-"));
		tmpDirs.push(dir);
		return new Config(join(dir, "config.json"));
	}

	function handlersWithRealConfig() {
		return createConfigHandlers(realConfig(), {
			port: 8080,
			tlsEnabled: false,
		});
	}

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.MODEL_SCOPED_CAPACITY_ROUTING;
		} else {
			process.env.MODEL_SCOPED_CAPACITY_ROUTING = originalEnv;
		}
		while (tmpDirs.length > 0) {
			rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
		}
	});

	it("reports source 'default' and mode 'off' with no env or file", async () => {
		delete process.env.MODEL_SCOPED_CAPACITY_ROUTING;
		const handlers = handlersWithRealConfig();

		const body = (await handlers.getModelCapacityRouting().json()) as {
			mode: string;
			source: string;
		};
		expect(body).toEqual({ mode: "off", source: "default" });
	});

	it("reports source 'file' after a POST writes the config file", async () => {
		delete process.env.MODEL_SCOPED_CAPACITY_ROUTING;
		const handlers = handlersWithRealConfig();

		const postResponse = await handlers.setModelCapacityRouting(
			new Request("http://localhost/api/config/model-capacity-routing", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "exhausted" }),
			}),
		);
		expect(postResponse.status).toBe(200);
		expect(await postResponse.json()).toEqual({
			success: true,
			mode: "exhausted",
			source: "file",
			effective: "exhausted",
		});

		const getBody = (await handlers.getModelCapacityRouting().json()) as {
			mode: string;
			source: string;
		};
		expect(getBody).toEqual({ mode: "exhausted", source: "file" });
	});

	it("reports source 'env' and effective env value when env overrides the file", async () => {
		process.env.MODEL_SCOPED_CAPACITY_ROUTING = "exhausted";
		const handlers = handlersWithRealConfig();

		const body = (await handlers.getModelCapacityRouting().json()) as {
			mode: string;
			source: string;
		};
		expect(body).toEqual({ mode: "exhausted", source: "env" });
	});

	it("POST while env-locked succeeds but effective reflects the env value", async () => {
		process.env.MODEL_SCOPED_CAPACITY_ROUTING = "exhausted";
		const handlers = handlersWithRealConfig();

		const postResponse = await handlers.setModelCapacityRouting(
			new Request("http://localhost/api/config/model-capacity-routing", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "off" }),
			}),
		);
		expect(postResponse.status).toBe(200);
		expect(await postResponse.json()).toEqual({
			success: true,
			mode: "off",
			source: "env",
			effective: "exhausted",
		});
	});
});

describe("strategy source (real config)", () => {
	const originalEnv = process.env.LB_STRATEGY;
	const tmpDirs: string[] = [];

	function realConfig(): Config {
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-handler-"));
		tmpDirs.push(dir);
		return new Config(join(dir, "config.json"));
	}

	function handlersWithRealConfig() {
		return createConfigHandlers(realConfig(), {
			port: 8080,
			tlsEnabled: false,
		});
	}

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.LB_STRATEGY;
		} else {
			process.env.LB_STRATEGY = originalEnv;
		}
		while (tmpDirs.length > 0) {
			rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
		}
	});

	it("reports source 'file' and strategy 'session' for a freshly created config", async () => {
		// loadConfig() eagerly seeds a brand-new config file with
		// `lb_strategy: DEFAULT_STRATEGY`, so a fresh Config already has a valid
		// file value here — unlike model-capacity-routing, "default" is only
		// reachable when the on-disk file predates the lb_strategy field.
		delete process.env.LB_STRATEGY;
		const handlers = handlersWithRealConfig();

		const body = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(body).toEqual({ strategy: "session", strategySource: "file" });
	});

	it("reports source 'file' after a POST writes the config file", async () => {
		delete process.env.LB_STRATEGY;
		const handlers = handlersWithRealConfig();

		const postResponse = await handlers.setStrategy(
			new Request("http://localhost/api/config/strategy", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ strategy: "session-drain-soonest" }),
			}),
		);
		expect(postResponse.status).toBe(200);

		const getBody = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(getBody).toEqual({
			strategy: "session-drain-soonest",
			strategySource: "file",
		});
	});

	it("reports source 'env' and the env strategy when LB_STRATEGY overrides the file", async () => {
		process.env.LB_STRATEGY = "least-used";
		const handlers = handlersWithRealConfig();

		const body = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(body).toEqual({ strategy: "least-used", strategySource: "env" });
	});

	it("keeps reporting the env-sourced strategy after a POST that writes the (ineffective) file value", async () => {
		process.env.LB_STRATEGY = "least-used";
		const handlers = handlersWithRealConfig();

		const postResponse = await handlers.setStrategy(
			new Request("http://localhost/api/config/strategy", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ strategy: "session" }),
			}),
		);
		expect(postResponse.status).toBe(200);

		const getBody = (await handlers.getStrategy().json()) as {
			strategy: string;
			strategySource: string;
		};
		expect(getBody).toEqual({ strategy: "least-used", strategySource: "env" });
	});
});
