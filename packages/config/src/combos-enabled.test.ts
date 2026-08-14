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

describe("getCombosEnabled / setCombosEnabled", () => {
	const originalEnv = process.env.BETTER_CCFLARE_SHOW_COMBOS;

	beforeEach(() => {
		delete process.env.BETTER_CCFLARE_SHOW_COMBOS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.BETTER_CCFLARE_SHOW_COMBOS;
		} else {
			process.env.BETTER_CCFLARE_SHOW_COMBOS = originalEnv;
		}
	});

	it("defaults to off, reported as coming from the default", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCombosEnabled()).toBe(false);
			expect(config.getCombosEnabledSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("honors the legacy env var, which used to gate only the dashboard tab", () => {
		process.env.BETTER_CCFLARE_SHOW_COMBOS = "true";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCombosEnabled()).toBe(true);
			expect(config.getCombosEnabledSource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it('accepts "1" as well, matching every other flag in this file', () => {
		process.env.BETTER_CCFLARE_SHOW_COMBOS = "1";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCombosEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("treats any other env value as an explicit off", () => {
		process.env.BETTER_CCFLARE_SHOW_COMBOS = "false";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCombosEnabled()).toBe(false);
			expect(config.getCombosEnabledSource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it("honors a config-file value when no env var is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCombosEnabled(true);
			expect(config.getCombosEnabled()).toBe(true);
			expect(config.getCombosEnabledSource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	it("lets the env var win over the file, so the write is reported as ineffective", () => {
		process.env.BETTER_CCFLARE_SHOW_COMBOS = "false";
		const { config, cleanup } = makeConfig();
		try {
			config.setCombosEnabled(true);
			// The write landed in the file, but the env var still decides — this
			// is what the dashboard shows as an env-locked control.
			expect(config.getCombosEnabled()).toBe(false);
			expect(config.getCombosEnabledSource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it("surfaces the effective value in getAllSettings", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCombosEnabled(true);
			expect(config.getAllSettings().combos_enabled).toBe(true);
		} finally {
			cleanup();
		}
	});
});
