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

describe("getUsageHistoryRetentionDays", () => {
	const original = process.env.USAGE_HISTORY_RETENTION_DAYS;
	beforeEach(() => {
		delete process.env.USAGE_HISTORY_RETENTION_DAYS;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.USAGE_HISTORY_RETENTION_DAYS;
		else process.env.USAGE_HISTORY_RETENTION_DAYS = original;
	});

	it("defaults to 90 when no env or file override", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUsageHistoryRetentionDays()).toBe(90);
		} finally {
			cleanup();
		}
	});

	it("reads and clamps the env override", () => {
		const { config, cleanup } = makeConfig();
		try {
			process.env.USAGE_HISTORY_RETENTION_DAYS = "5000"; // above max
			expect(config.getUsageHistoryRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});
});
