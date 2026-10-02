import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV = "CCFLARE_USE_EXTRA_USAGE";

function makeConfig(dir = mkdtempSync(join(tmpdir(), "bcc-extra-usage-"))) {
	return {
		dir,
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getUseExtraUsage / setUseExtraUsage", () => {
	const original = process.env[ENV];

	beforeEach(() => {
		delete process.env[ENV];
	});

	afterEach(() => {
		if (original === undefined) delete process.env[ENV];
		else process.env[ENV] = original;
	});

	it("is off by default: extra usage is billed, so spending it must be chosen", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUseExtraUsage()).toBe(false);
			expect(config.getUseExtraUsageSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("honours and persists a dashboard write", () => {
		const { dir, config, cleanup } = makeConfig();
		try {
			config.setUseExtraUsage(true);
			expect(config.getUseExtraUsage()).toBe(true);
			expect(config.getUseExtraUsageSource()).toBe("file");
			// A fresh read of the same file sees the same answer.
			expect(new Config(join(dir, "config.json")).getUseExtraUsage()).toBe(
				true,
			);
		} finally {
			cleanup();
		}
	});

	it("does not let the environment override the switch at read time", () => {
		process.env[ENV] = "true";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUseExtraUsage()).toBe(false);
			expect(config.getUseExtraUsageSource()).toBe("default");
		} finally {
			cleanup();
		}
	});
});

describe("adoptUseExtraUsageFromEnv", () => {
	const original = process.env[ENV];

	beforeEach(() => {
		delete process.env[ENV];
	});

	afterEach(() => {
		if (original === undefined) delete process.env[ENV];
		else process.env[ENV] = original;
	});

	it("seeds an unset switch from the environment, once, and says so", () => {
		process.env[ENV] = "on";
		const { config, cleanup } = makeConfig();
		try {
			const note = config.adoptUseExtraUsageFromEnv();
			expect(note).toContain(ENV);
			expect(config.getUseExtraUsage()).toBe(true);
			expect(config.getUseExtraUsageSource()).toBe("file");
			// Already adopted: a second boot changes nothing and says nothing.
			expect(config.adoptUseExtraUsageFromEnv()).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("never overrides a choice already made in the dashboard", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUseExtraUsage(false);
			process.env[ENV] = "true";
			expect(config.adoptUseExtraUsageFromEnv()).toBeNull();
			expect(config.getUseExtraUsage()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("accepts an explicit off and ignores values it cannot read", () => {
		process.env[ENV] = "0";
		const off = makeConfig();
		try {
			expect(off.config.adoptUseExtraUsageFromEnv()).not.toBeNull();
			expect(off.config.getUseExtraUsage()).toBe(false);
			expect(off.config.getUseExtraUsageSource()).toBe("file");
		} finally {
			off.cleanup();
		}

		process.env[ENV] = "sometimes";
		const junk = makeConfig();
		try {
			expect(junk.config.adoptUseExtraUsageFromEnv()).toBeNull();
			expect(junk.config.getUseExtraUsageSource()).toBe("default");
		} finally {
			junk.cleanup();
		}
	});

	it("does nothing when the variable is absent", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.adoptUseExtraUsageFromEnv()).toBeNull();
			expect(config.getUseExtraUsageSource()).toBe("default");
		} finally {
			cleanup();
		}
	});
});
