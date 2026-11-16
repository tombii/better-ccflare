import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { setCostTrackingEnabled } from "@better-ccflare/core";
import {
	configureCostTracking,
	parseCostTrackingValue,
} from "../cost-tracking";

afterEach(() => setCostTrackingEnabled(true));
describe("cost tracking CLI", () => {
	it("parses on/off and rejects missing or invalid choices", () => {
		expect(parseCostTrackingValue("on")).toBe(true);
		expect(parseCostTrackingValue("off")).toBe(false);
		for (const value of [undefined, "", "maybe"])
			expect(() => parseCostTrackingValue(value)).toThrow("on or off");
	});
	it("persists the setting and notifies local servers without a real API key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-cost-cli-"));
		try {
			const config = new Config(join(dir, "config.json"));
			const notify = mock(async () => new Response(null, { status: 204 }));
			await configureCostTracking(config, "off", notify as never);
			expect(
				new Config(join(dir, "config.json")).getCostTrackingEnabled(),
			).toBe(false);
			expect(notify).toHaveBeenCalled();
			const [url, init] = notify.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(url).toContain("/api/config/cost-tracking/reload");
			expect(init.method).toBe("POST");
			expect(new Headers(init.headers).has("x-api-key")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
