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

describe("getAutoVacuumEnabled", () => {
	const originalEnv = process.env.BETTER_CCFLARE_AUTO_VACUUM;

	beforeEach(() => {
		delete process.env.BETTER_CCFLARE_AUTO_VACUUM;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.BETTER_CCFLARE_AUTO_VACUUM;
		} else {
			process.env.BETTER_CCFLARE_AUTO_VACUUM = originalEnv;
		}
	});

	it("defaults to true when no env or file override — unattended reclaim is unchanged for existing installs", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAutoVacuumEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("is disabled by env='false'", () => {
		process.env.BETTER_CCFLARE_AUTO_VACUUM = "false";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAutoVacuumEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("is disabled by env='0'", () => {
		process.env.BETTER_CCFLARE_AUTO_VACUUM = "0";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAutoVacuumEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("treats any other set env value as enabled — matches getStorePayloads()'s opt-out shape", () => {
		process.env.BETTER_CCFLARE_AUTO_VACUUM = "1";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAutoVacuumEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("honors a config-file override when no env is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.set("auto_vacuum_enabled", false);
			expect(config.getAutoVacuumEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("prioritizes the env override over a config-file value", () => {
		process.env.BETTER_CCFLARE_AUTO_VACUUM = "false";
		const { config, cleanup } = makeConfig();
		try {
			config.set("auto_vacuum_enabled", true);
			expect(config.getAutoVacuumEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("setAutoVacuumEnabled persists the value read back by the getter", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setAutoVacuumEnabled(false);
			expect(config.getAutoVacuumEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("is included in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAllSettings().auto_vacuum_enabled).toBe(true);
		} finally {
			cleanup();
		}
	});
});
