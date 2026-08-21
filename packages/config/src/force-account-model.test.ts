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

describe("getForceAccountModel / setForceAccountModel", () => {
	const originalEnv = process.env.CCFLARE_FORCE_ACCOUNT_MODEL;

	beforeEach(() => {
		delete process.env.CCFLARE_FORCE_ACCOUNT_MODEL;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CCFLARE_FORCE_ACCOUNT_MODEL;
		} else {
			process.env.CCFLARE_FORCE_ACCOUNT_MODEL = originalEnv;
		}
	});

	it("is off by default: it changes what a Claude family name means, so it must be chosen", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getForceAccountModel()).toBe(false);
			expect(config.getForceAccountModelSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("ignores the environment entirely: this switch belongs to the dashboard", () => {
		// Shipped without an environment variable on purpose. One that could
		// override would force the UI to draw a control that accepts a click and
		// does nothing — see ConfigFlagDialog.
		process.env.CCFLARE_FORCE_ACCOUNT_MODEL = "true";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getForceAccountModel()).toBe(false);
			expect(config.getForceAccountModelSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("honors a config-file value when no env var is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setForceAccountModel(true);
			expect(config.getForceAccountModel()).toBe(true);
			expect(config.getForceAccountModelSource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	it("surfaces the effective value in getAllSettings", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setForceAccountModel(true);
			expect(config.getAllSettings().force_account_model).toBe(true);
		} finally {
			cleanup();
		}
	});
});
