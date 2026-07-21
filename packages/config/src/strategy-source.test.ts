import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrategyName } from "@better-ccflare/core";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/**
 * Unlike model_scoped_capacity_routing, Config#loadConfig() eagerly seeds a
 * brand-new config file with `{ lb_strategy: DEFAULT_STRATEGY }` (index.ts
 * loadConfig()). So a freshly created Config already has a valid file value
 * and getStrategySource() reports "file", never "default" — the "default"
 * source is only reachable when the on-disk file predates the lb_strategy
 * field (e.g. hand-edited or written by an older version). This helper
 * reproduces that pre-existing-file case.
 */
function makeConfigFromRawFile(raw: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify(raw), "utf8");
	return {
		config: new Config(configPath),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getStrategy / getStrategySource", () => {
	const originalEnv = process.env.LB_STRATEGY;

	beforeEach(() => {
		delete process.env.LB_STRATEGY;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.LB_STRATEGY;
		} else {
			process.env.LB_STRATEGY = originalEnv;
		}
	});

	it("reports source 'file' for a freshly created config (loadConfig eagerly seeds lb_strategy)", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getStrategy()).toBe(StrategyName.Session);
			expect(config.getStrategySource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	it("reports source 'default' when the on-disk file predates the lb_strategy field", () => {
		const { config, cleanup } = makeConfigFromRawFile({});
		try {
			expect(config.getStrategy()).toBe(StrategyName.Session);
			expect(config.getStrategySource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("honors a valid env override", () => {
		process.env.LB_STRATEGY = StrategyName.LeastUsed;
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getStrategy()).toBe(StrategyName.LeastUsed);
			expect(config.getStrategySource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it("falls back to the default for an invalid env value when the file predates lb_strategy", () => {
		process.env.LB_STRATEGY = "not-a-real-strategy";
		const { config, cleanup } = makeConfigFromRawFile({});
		try {
			expect(config.getStrategy()).toBe(StrategyName.Session);
			expect(config.getStrategySource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("falls back to the file value when an invalid env value is set and a file value exists", () => {
		process.env.LB_STRATEGY = "not-a-real-strategy";
		const { config, cleanup } = makeConfig();
		try {
			config.setStrategy(StrategyName.SessionDrainSoonest);
			expect(config.getStrategy()).toBe(StrategyName.SessionDrainSoonest);
			expect(config.getStrategySource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	it("honors a config-file override set via setStrategy", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setStrategy(StrategyName.SessionAffinity);
			expect(config.getStrategy()).toBe(StrategyName.SessionAffinity);
			expect(config.getStrategySource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	it("prioritizes the env override over a config-file value", () => {
		process.env.LB_STRATEGY = StrategyName.Session;
		const { config, cleanup } = makeConfig();
		try {
			config.setStrategy(StrategyName.SessionDrainSoonest);
			expect(config.getStrategy()).toBe(StrategyName.Session);
			expect(config.getStrategySource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it("throws on an invalid strategy passed to the setter", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(() =>
				config.setStrategy(
					// biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard
					"not-a-real-strategy" as any,
				),
			).toThrow();
		} finally {
			cleanup();
		}
	});

	it("reports source 'env' even when a config-file value is also set", () => {
		process.env.LB_STRATEGY = StrategyName.Session;
		const { config, cleanup } = makeConfig();
		try {
			config.setStrategy(StrategyName.SessionDrainSoonest);
			expect(config.getStrategySource()).toBe("env");
		} finally {
			cleanup();
		}
	});
});
