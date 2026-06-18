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

describe("getDataRetentionDays", () => {
	const originalEnv = process.env.DATA_RETENTION_DAYS;

	beforeEach(() => {
		delete process.env.DATA_RETENTION_DAYS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.DATA_RETENTION_DAYS;
		} else {
			process.env.DATA_RETENTION_DAYS = originalEnv;
		}
	});

	it("defaults to 1 day when no env or file override", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getDataRetentionDays()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("honors the env override (clamped to 1..365)", () => {
		process.env.DATA_RETENTION_DAYS = "5";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getDataRetentionDays()).toBe(5);
		} finally {
			cleanup();
		}
	});

	it("honors a file override", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setDataRetentionDays(10);
			expect(config.getDataRetentionDays()).toBe(10);
		} finally {
			cleanup();
		}
	});
});
