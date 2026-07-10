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

describe("getModelCatalogOAuthRefreshEnabled", () => {
	const originalEnv = process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH;

	beforeEach(() => {
		delete process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH;
		} else {
			process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH = originalEnv;
		}
	});

	it("defaults to false when no env or file override", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getModelCatalogOAuthRefreshEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("honors a truthy env override", () => {
		process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH = "1";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getModelCatalogOAuthRefreshEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("treats a non-true env value as disabled", () => {
		process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH = "disabled";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getModelCatalogOAuthRefreshEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("honors a config-file override when no env is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.set("model_catalog_oauth_refresh_enabled", true);
			expect(config.getModelCatalogOAuthRefreshEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("prioritizes the env override over a config-file value", () => {
		process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH = "false";
		const { config, cleanup } = makeConfig();
		try {
			config.set("model_catalog_oauth_refresh_enabled", true);
			expect(config.getModelCatalogOAuthRefreshEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("is included in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAllSettings().model_catalog_oauth_refresh_enabled).toBe(
				false,
			);
		} finally {
			cleanup();
		}
	});
});
