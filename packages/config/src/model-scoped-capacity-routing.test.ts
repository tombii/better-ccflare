import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getModelScopedCapacityRouting / setModelScopedCapacityRouting", () => {
	const originalEnv = process.env.MODEL_SCOPED_CAPACITY_ROUTING;

	beforeEach(() => {
		delete process.env.MODEL_SCOPED_CAPACITY_ROUTING;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.MODEL_SCOPED_CAPACITY_ROUTING;
		} else {
			process.env.MODEL_SCOPED_CAPACITY_ROUTING = originalEnv;
		}
	});

	it("defaults to 'off' when no env or file override", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getModelScopedCapacityRouting()).toBe("off");
		} finally {
			cleanup();
		}
	});

	it("honors a valid env override", () => {
		process.env.MODEL_SCOPED_CAPACITY_ROUTING = "exhausted";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getModelScopedCapacityRouting()).toBe("exhausted");
		} finally {
			cleanup();
		}
	});

	it("falls back to 'off' for an invalid env value", () => {
		process.env.MODEL_SCOPED_CAPACITY_ROUTING = "always";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getModelScopedCapacityRouting()).toBe("off");
		} finally {
			cleanup();
		}
	});

	it("honors a config-file override set via setModelScopedCapacityRouting", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setModelScopedCapacityRouting("exhausted");
			expect(config.getModelScopedCapacityRouting()).toBe("exhausted");
		} finally {
			cleanup();
		}
	});

	it("prioritizes the env override over a config-file value", () => {
		process.env.MODEL_SCOPED_CAPACITY_ROUTING = "off";
		const { config, cleanup } = makeConfig();
		try {
			config.setModelScopedCapacityRouting("exhausted");
			expect(config.getModelScopedCapacityRouting()).toBe("off");
		} finally {
			cleanup();
		}
	});

	it("throws on an invalid mode passed to the setter", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(() =>
				config.setModelScopedCapacityRouting(
					// biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard
					"always" as any,
				),
			).toThrow();
		} finally {
			cleanup();
		}
	});

	it("is included in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAllSettings().model_scoped_capacity_routing).toBe("off");
		} finally {
			cleanup();
		}
	});
});
