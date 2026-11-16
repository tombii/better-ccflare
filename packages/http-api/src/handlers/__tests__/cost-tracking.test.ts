import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import {
	isCostTrackingEnabled,
	setCostTrackingEnabled,
} from "@better-ccflare/core";
import { AuthService } from "../../services/auth-service";
import { createConfigHandlers } from "../config";

afterEach(() => setCostTrackingEnabled(true));

describe("cost tracking settings API", () => {
	it("reads the default and updates persisted and runtime state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bcc-cost-api-"));
		try {
			const config = new Config(join(dir, "config.json"));
			const handlers = createConfigHandlers(config);
			expect(await handlers.getCostTracking().json()).toEqual({
				enabled: true,
				source: "default",
			});
			for (const enabled of [false, true]) {
				const res = await handlers.setCostTracking(
					new Request("http://localhost/api/config/cost-tracking", {
						method: "POST",
						body: JSON.stringify({ enabled }),
					}),
				);
				expect(res.status).toBe(200);
				expect(await res.json()).toMatchObject({
					success: true,
					enabled,
					effective: enabled,
					source: "file",
				});
				expect(isCostTrackingEnabled()).toBe(enabled);
				expect(
					new Config(join(dir, "config.json")).getCostTrackingEnabled(),
				).toBe(enabled);
			}
			const invalid = await handlers.setCostTracking(
				new Request("http://localhost/api/config/cost-tracking", {
					method: "POST",
					body: '{"enabled":"off"}',
				}),
			);
			expect(invalid.status).toBe(400);
			expect(isCostTrackingEnabled()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("allows api-only keys to read only the tracking flag", async () => {
		const auth = new AuthService({} as never, {} as never);
		const key = { role: "api-only" } as never;
		expect(
			await auth.authorizeEndpoint(key, "/api/config/cost-tracking", "GET"),
		).toEqual({ authorized: true });
		for (const method of ["POST", "PUT"]) {
			expect(
				(await auth.authorizeEndpoint(key, "/api/config/cost-tracking", method))
					.authorized,
			).toBe(false);
		}
		expect(
			(await auth.authorizeEndpoint(key, "/api/config", "GET")).authorized,
		).toBe(false);
	});
	it("requires the local-control secret to reload the saved setting", async () => {
		const auth = new AuthService(
			{ countActiveApiKeys: async () => 1 } as never,
			undefined,
			"fixture-local-control-secret",
		);
		const path = "/api/config/cost-tracking/reload";
		expect(await auth.isPathExempt(path, "POST", new Headers())).toBe(false);
		expect(
			await auth.isPathExempt(
				path,
				"POST",
				new Headers({ "x-better-ccflare-local-control-secret": "wrong" }),
			),
		).toBe(false);
		expect(
			await auth.isPathExempt(
				path,
				"POST",
				new Headers({
					"x-better-ccflare-local-control-secret":
						"fixture-local-control-secret",
				}),
			),
		).toBe(true);
		expect(
			await auth.isPathExempt(
				"/api/config/cost-tracking",
				"POST",
				new Headers({
					"x-better-ccflare-local-control-secret":
						"fixture-local-control-secret",
				}),
			),
		).toBe(false);
	});
});
