import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "@better-ccflare/core";
import { Config } from "./index";

function makeConfig(raw?: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	const configPath = join(dir, "config.json");
	if (raw) writeFileSync(configPath, JSON.stringify(raw), "utf8");
	return {
		config: new Config(configPath),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("NIGHT_WINDOW / NIGHT_TZ", () => {
	const originalWindow = process.env.NIGHT_WINDOW;
	const originalTz = process.env.NIGHT_TZ;

	beforeEach(() => {
		delete process.env.NIGHT_WINDOW;
		delete process.env.NIGHT_TZ;
	});

	afterEach(() => {
		if (originalWindow === undefined) delete process.env.NIGHT_WINDOW;
		else process.env.NIGHT_WINDOW = originalWindow;
		if (originalTz === undefined) delete process.env.NIGHT_TZ;
		else process.env.NIGHT_TZ = originalTz;
	});

	it("defaults to empty (feature off / UTC) when neither env nor file is set", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getNightWindow()).toBe("");
			expect(config.getNightTz()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("uses the file value when the env var is unset", () => {
		const { config, cleanup } = makeConfig({
			night_window: "22:00-08:00",
			night_tz: "Europe/Berlin",
		});
		try {
			expect(config.getNightWindow()).toBe("22:00-08:00");
			expect(config.getNightTz()).toBe("Europe/Berlin");
		} finally {
			cleanup();
		}
	});

	it("lets a valid env override win over the file value", () => {
		process.env.NIGHT_WINDOW = "01:00-05:00";
		process.env.NIGHT_TZ = "America/New_York";
		const { config, cleanup } = makeConfig({
			night_window: "22:00-08:00",
			night_tz: "Europe/Berlin",
		});
		try {
			expect(config.getNightWindow()).toBe("01:00-05:00");
			expect(config.getNightTz()).toBe("America/New_York");
		} finally {
			cleanup();
		}
	});

	it("falls back to the file value when the env value is invalid", () => {
		process.env.NIGHT_WINDOW = "garbage";
		process.env.NIGHT_TZ = "Not/AZone";
		const { config, cleanup } = makeConfig({
			night_window: "22:00-08:00",
			night_tz: "Europe/Berlin",
		});
		try {
			expect(config.getNightWindow()).toBe("22:00-08:00");
			expect(config.getNightTz()).toBe("Europe/Berlin");
		} finally {
			cleanup();
		}
	});

	it("treats invalid values with no file fallback as off (empty string)", () => {
		process.env.NIGHT_WINDOW = "25:00-08:00";
		process.env.NIGHT_TZ = "Not/AZone";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getNightWindow()).toBe("");
			expect(config.getNightTz()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("treats an explicit empty env value as off", () => {
		process.env.NIGHT_WINDOW = "";
		process.env.NIGHT_TZ = "";
		const { config, cleanup } = makeConfig({
			night_window: "22:00-08:00",
			night_tz: "Europe/Berlin",
		});
		try {
			expect(config.getNightWindow()).toBe("");
			expect(config.getNightTz()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("ignores a malformed file value", () => {
		const { config, cleanup } = makeConfig({
			night_window: "22-8",
			night_tz: 42,
		});
		try {
			expect(config.getNightWindow()).toBe("");
			expect(config.getNightTz()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("exposes the effective values via getAllSettings", () => {
		process.env.NIGHT_WINDOW = "23:00-07:00";
		const { config, cleanup } = makeConfig({ night_tz: "UTC" });
		try {
			const all = config.getAllSettings();
			expect(all.night_window).toBe("23:00-07:00");
			expect(all.night_tz).toBe("UTC");
		} finally {
			cleanup();
		}
	});
});

describe("setNightWindow / setNightTz", () => {
	it("persists valid values", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setNightWindow("22:00-08:00");
			config.setNightTz("Europe/Berlin");
			expect(config.getNightWindow()).toBe("22:00-08:00");
			expect(config.getNightTz()).toBe("Europe/Berlin");
		} finally {
			cleanup();
		}
	});

	it("allows empty string to turn the feature off / reset to UTC", () => {
		const { config, cleanup } = makeConfig({
			night_window: "22:00-08:00",
			night_tz: "Europe/Berlin",
		});
		try {
			config.setNightWindow("");
			config.setNightTz("");
			expect(config.getNightWindow()).toBe("");
			expect(config.getNightTz()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("rejects a malformed window with ValidationError", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(() => config.setNightWindow("garbage")).toThrow(ValidationError);
			expect(() => config.setNightWindow("25:00-08:00")).toThrow(
				ValidationError,
			);
			expect(config.getNightWindow()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("rejects an invalid timezone with ValidationError", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(() => config.setNightTz("Not/AZone")).toThrow(ValidationError);
			expect(config.getNightTz()).toBe("");
		} finally {
			cleanup();
		}
	});
});
