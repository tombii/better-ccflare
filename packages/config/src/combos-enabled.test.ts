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

describe("combos and combo session fallback settings", () => {
	const originalShow = process.env.BETTER_CCFLARE_SHOW_COMBOS;
	const originalDisable = process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;

	beforeEach(() => {
		delete process.env.BETTER_CCFLARE_SHOW_COMBOS;
		delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
	});

	afterEach(() => {
		if (originalShow === undefined) {
			delete process.env.BETTER_CCFLARE_SHOW_COMBOS;
		} else {
			process.env.BETTER_CCFLARE_SHOW_COMBOS = originalShow;
		}
		if (originalDisable === undefined) {
			delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
		} else {
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = originalDisable;
		}
	});

	it("starts with combos off and the fallback blocked", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCombosEnabled()).toBe(false);
			expect(config.getCombosEnabledSource()).toBe("default");
			expect(config.getComboSessionFallback()).toBe(false);
			expect(config.getComboSessionFallbackSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("is not overridden by the environment, so the dashboard switch cannot lie", () => {
		// This is the whole point of the move: a variable that could win would
		// force the UI to draw a control that accepts a click and does nothing.
		process.env.BETTER_CCFLARE_SHOW_COMBOS = "true";
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		const { config, cleanup } = makeConfig();
		try {
			config.setCombosEnabled(false);
			config.setComboSessionFallback(true);
			expect(config.getCombosEnabled()).toBe(false);
			expect(config.getComboSessionFallback()).toBe(true);
			expect(config.getCombosEnabledSource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	describe("adoptLegacyRoutingSettings", () => {
		it("adopts the old show-combos variable once, then leaves it alone", () => {
			process.env.BETTER_CCFLARE_SHOW_COMBOS = "true";
			const { config, cleanup } = makeConfig();
			try {
				const notes = config.adoptLegacyRoutingSettings(false);
				expect(config.getCombosEnabled()).toBe(true);
				expect(config.getCombosEnabledSource()).toBe("file");
				expect(notes.length).toBe(1);

				// Second boot: the field exists now, so a deliberate off stays off
				// even with the variable still sitting in the environment.
				config.setCombosEnabled(false);
				expect(config.adoptLegacyRoutingSettings(false)).toEqual([]);
				expect(config.getCombosEnabled()).toBe(false);
			} finally {
				cleanup();
			}
		});

		it("inverts the old disable-fallback variable into the positive setting", () => {
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
			const { config, cleanup } = makeConfig();
			try {
				config.adoptLegacyRoutingSettings(false);
				expect(config.getComboSessionFallback()).toBe(false);
				expect(config.getComboSessionFallbackSource()).toBe("file");
			} finally {
				cleanup();
			}
		});

		it("keeps the permissive spellings the old variable accepted", () => {
			for (const raw of ["1", "yes", "on", "TRUE"]) {
				process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = raw;
				const { config, cleanup } = makeConfig();
				try {
					config.adoptLegacyRoutingSettings(false);
					expect(config.getComboSessionFallback()).toBe(false);
				} finally {
					cleanup();
				}
			}
		});

		it("reads an unrecognised value as not disabling, and still records it", () => {
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "maybe";
			const { config, cleanup } = makeConfig();
			try {
				config.adoptLegacyRoutingSettings(false);
				expect(config.getComboSessionFallback()).toBe(true);
				expect(config.getComboSessionFallbackSource()).toBe("file");
			} finally {
				cleanup();
			}
		});

		it("ignores an empty variable, which is not an opinion", () => {
			process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "";
			const { config, cleanup } = makeConfig();
			try {
				config.adoptLegacyRoutingSettings(false);
				expect(config.getComboSessionFallbackSource()).toBe("default");
			} finally {
				cleanup();
			}
		});

		it("preserves both historical routing behaviours for an install with combos", () => {
			const { config, cleanup } = makeConfig();
			try {
				const notes = config.adoptLegacyRoutingSettings(true);
				expect(config.getCombosEnabled()).toBe(true);
				expect(config.getComboSessionFallback()).toBe(true);
				expect(config.getComboSessionFallbackSource()).toBe("file");
				expect(notes.length).toBe(2);
			} finally {
				cleanup();
			}
		});

		it("never overwrites a deliberate blocked fallback", () => {
			const { config, cleanup } = makeConfig();
			try {
				config.setComboSessionFallback(false);
				expect(config.adoptLegacyRoutingSettings(true)).toEqual([
					"combos enabled: this install already has combos, so the routing it was already doing is kept. Turn it off in the dashboard's Combos tab",
				]);
				expect(config.getComboSessionFallback()).toBe(false);
			} finally {
				cleanup();
			}
		});

		it("leaves a fresh install alone", () => {
			const { config, cleanup } = makeConfig();
			try {
				expect(config.adoptLegacyRoutingSettings(false)).toEqual([]);
				expect(config.getCombosEnabledSource()).toBe("default");
				expect(config.getComboSessionFallbackSource()).toBe("default");
			} finally {
				cleanup();
			}
		});

		it("prefers the variable over the has-combos guess when both apply", () => {
			process.env.BETTER_CCFLARE_SHOW_COMBOS = "false";
			const { config, cleanup } = makeConfig();
			try {
				config.adoptLegacyRoutingSettings(true);
				// Someone wrote the variable on purpose; the database is only a
				// fallback for installs that never expressed anything.
				expect(config.getCombosEnabled()).toBe(false);
			} finally {
				cleanup();
			}
		});
	});

	it("surfaces both effective values in getAllSettings", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCombosEnabled(true);
			config.setComboSessionFallback(true);
			expect(config.getAllSettings().combos_enabled).toBe(true);
			expect(config.getAllSettings().combo_session_fallback).toBe(true);
		} finally {
			cleanup();
		}
	});
});
