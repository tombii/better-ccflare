/**
 * Tests for dashboard_auth_enabled bypass in AuthService.isPathExempt.
 *
 * Test cases:
 *   1. dashboard_auth_enabled=true  + keys exist + /api/stats:                NOT exempt (current behaviour preserved)
 *   2. dashboard_auth_enabled=false + keys exist + /api/stats:                IS exempt
 *   3. dashboard_auth_enabled=false + keys exist + /v1/messages:              NOT exempt (proxy still gated)
 *   4. dashboard_auth_enabled=false + keys exist + /api/debug/heap:           NOT exempt (debug carve-out)
 *   5. dashboard_auth_enabled=false + no keys   + /api/stats:                 IS exempt
 *   6. dashboard_auth_enabled=false + keys exist + /api/config/dashboard-auth POST: IS exempt
 *   7. dashboard_auth_enabled=false + no keys   + /api/api-keys POST:         IS exempt (first-key creation)
 *   8. dashboard_auth_enabled=false + keys exist + /api/api-keys POST:        NOT exempt (key management gated)
 */

import { describe, expect, test } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "@better-ccflare/http-api";

function makeDbOps(hasKeys: boolean): DatabaseOperations {
	return {
		countActiveApiKeys: async () => (hasKeys ? 1 : 0),
		getActiveApiKeys: async () => [],
		updateApiKeyUsage: () => {},
	} as unknown as DatabaseOperations;
}

function makeConfig(dashboardAuthEnabled: boolean) {
	return {
		getDashboardAuthEnabled: () => dashboardAuthEnabled,
	};
}

describe("AuthService.isPathExempt — dashboard_auth_enabled bypass", () => {
	describe("default behaviour (dashboard_auth_enabled=true)", () => {
		test("case 1: keys exist + /api/stats is NOT exempt", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(true));
			expect(await svc.isPathExempt("/api/stats", "GET")).toBe(false);
		});

		test("no keys + /api/stats: isPathExempt still false (no-keys path is in authenticateRequest)", async () => {
			const svc = new AuthService(makeDbOps(false), makeConfig(true));
			expect(await svc.isPathExempt("/api/stats", "GET")).toBe(false);
		});
	});

	describe("bypass active (dashboard_auth_enabled=false)", () => {
		test("case 2: keys exist + /api/stats IS exempt", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/api/stats", "GET")).toBe(true);
		});

		test("case 3: keys exist + /v1/messages is NOT exempt (proxy still gated)", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/v1/messages", "POST")).toBe(false);
		});

		test("case 3b: keys exist + /messages/test is NOT exempt (proxy still gated)", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/messages/test", "POST")).toBe(false);
		});

		test("case 4: keys exist + /api/debug/heap is NOT exempt (debug carve-out)", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/api/debug/heap", "GET")).toBe(false);
		});

		test("case 4b: keys exist + /api/debug/snapshot is NOT exempt", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/api/debug/snapshot", "GET")).toBe(false);
		});

		test("case 4c: keys exist + /api/debugger (no slash) is NOT exempt — carve-out covers /api/debug prefix without trailing slash", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/api/debugger", "GET")).toBe(false);
		});

		test("case 5: no keys + /api/stats IS exempt (bypass fires unconditionally)", async () => {
			const svc = new AuthService(makeDbOps(false), makeConfig(false));
			expect(await svc.isPathExempt("/api/stats", "GET")).toBe(true);
		});

		test("case 6: keys exist + /api/config/dashboard-auth POST IS exempt", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/api/config/dashboard-auth", "POST")).toBe(
				true,
			);
		});

		test("case 7: no keys + /api/api-keys POST IS exempt (first-key creation)", async () => {
			const svc = new AuthService(makeDbOps(false), makeConfig(false));
			expect(await svc.isPathExempt("/api/api-keys", "POST")).toBe(true);
		});

		test("case 8: keys exist + /api/api-keys POST is NOT exempt (key management gated)", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/api/api-keys", "POST")).toBe(false);
		});

		test("case 8b: keys exist + /api/api-keys GET is NOT exempt", async () => {
			const svc = new AuthService(makeDbOps(true), makeConfig(false));
			expect(await svc.isPathExempt("/api/api-keys", "GET")).toBe(false);
		});
	});

	describe("backward compat (no config arg)", () => {
		test("new AuthService(dbOps) works; /api/stats still not exempt", async () => {
			const svc = new AuthService(makeDbOps(true));
			expect(await svc.isPathExempt("/api/stats", "GET")).toBe(false);
		});
	});
});
