import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

describe("cost tracking configuration", () => {
	it("defaults on and persists an explicit off and on across reloads", () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-cost-config-"));
		try {
			const path = join(dir, "config.json");
			const config = new Config(path);
			expect(config.getCostTrackingEnabled()).toBe(true);
			expect(config.getCostTrackingEnabledSource()).toBe("default");
			config.setCostTrackingEnabled(false);
			expect(new Config(path).getCostTrackingEnabled()).toBe(false);
			expect(config.getCostTrackingEnabledSource()).toBe("file");
			config.setCostTrackingEnabled(true);
			expect(new Config(path).getCostTrackingEnabled()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("reloads only the cost flag written by a separate CLI process", () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-cost-reload-"));
		try {
			const path = join(dir, "config.json");
			const server = new Config(path);
			const cli = new Config(path);
			cli.setCostTrackingEnabled(false);
			expect(server.getCostTrackingEnabled()).toBe(true);
			server.reloadCostTrackingEnabled();
			expect(server.getCostTrackingEnabled()).toBe(false);
			cli.setCostTrackingEnabled(true);
			server.reloadCostTrackingEnabled();
			expect(server.getCostTrackingEnabled()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
