/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ORIGINAL_ENV = {
	USAGE_THROTTLING_FIVE_HOUR_ENABLED:
		process.env.USAGE_THROTTLING_FIVE_HOUR_ENABLED,
	USAGE_THROTTLING_WEEKLY_ENABLED: process.env.USAGE_THROTTLING_WEEKLY_ENABLED,
};

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("usage throttling env flags", () => {
	afterEach(() => {
		process.env.USAGE_THROTTLING_FIVE_HOUR_ENABLED =
			ORIGINAL_ENV.USAGE_THROTTLING_FIVE_HOUR_ENABLED;
		process.env.USAGE_THROTTLING_WEEKLY_ENABLED =
			ORIGINAL_ENV.USAGE_THROTTLING_WEEKLY_ENABLED;
	});

	it("treats non-true granular env values as disabled", () => {
		process.env.USAGE_THROTTLING_FIVE_HOUR_ENABLED = "disabled";
		process.env.USAGE_THROTTLING_WEEKLY_ENABLED = "disabled";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getUsageThrottlingFiveHourEnabled()).toBe(false);
			expect(config.getUsageThrottlingWeeklyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("still enables throttling for explicit true values", () => {
		process.env.USAGE_THROTTLING_FIVE_HOUR_ENABLED = "1";
		process.env.USAGE_THROTTLING_WEEKLY_ENABLED = "true";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getUsageThrottlingFiveHourEnabled()).toBe(true);
			expect(config.getUsageThrottlingWeeklyEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});
});
