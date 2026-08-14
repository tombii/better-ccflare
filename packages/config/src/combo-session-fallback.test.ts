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

describe("getComboSessionFallback / setComboSessionFallback", () => {
	const originalEnv = process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;

	beforeEach(() => {
		delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
		} else {
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = originalEnv;
		}
	});

	it("defaults to allowing the fallback, which is the historical behaviour", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getComboSessionFallback()).toBe(true);
			expect(config.getComboSessionFallbackSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("inverts the disable env var, since the setting is stored positively", () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getComboSessionFallback()).toBe(false);
			expect(config.getComboSessionFallbackSource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it("keeps the permissive spellings the env var already accepted", () => {
		for (const raw of ["1", "yes", "on", "TRUE"]) {
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = raw;
			const { config, cleanup } = makeConfig();
			try {
				expect(config.getComboSessionFallback()).toBe(false);
			} finally {
				cleanup();
			}
		}
	});

	it("treats an unrecognised env value as not disabling", () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "maybe";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getComboSessionFallback()).toBe(true);
			// Still env-sourced: the variable is present and decided the answer,
			// so the dashboard must show the control as locked.
			expect(config.getComboSessionFallbackSource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it("honors a config-file value when no env var is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setComboSessionFallback(false);
			expect(config.getComboSessionFallback()).toBe(false);
			expect(config.getComboSessionFallbackSource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	it("lets the env var win over the file", () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		const { config, cleanup } = makeConfig();
		try {
			config.setComboSessionFallback(true);
			expect(config.getComboSessionFallback()).toBe(false);
			expect(config.getComboSessionFallbackSource()).toBe("env");
		} finally {
			cleanup();
		}
	});

	it("ignores an empty env var, so an unset-but-declared variable is not an opinion", () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "";
		const { config, cleanup } = makeConfig();
		try {
			config.setComboSessionFallback(false);
			expect(config.getComboSessionFallback()).toBe(false);
			expect(config.getComboSessionFallbackSource()).toBe("file");
		} finally {
			cleanup();
		}
	});
});
