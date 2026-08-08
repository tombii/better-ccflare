/**
 * Tests for the GET /api/sessions/:sessionId/account auth exemption
 * (issue #318, reduced scope). This route is a read-only, DB-backed lookup
 * intended for local status-line integrations, so — like /health and
 * /api/version/check — it must be reachable without an API key.
 *
 * The exemption is intentionally GET-only and structurally exact (5 path
 * segments: "", "api", "sessions", <id>, "account") so it can never widen
 * into an unauthenticated bypass for some other /api/sessions/* route that
 * might be added later, or for a non-GET method on this same path.
 */
import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "../auth-service";

function makeDbOpsWithApiKeys(): DatabaseOperations {
	// countActiveApiKeys() > 0 is what flips AuthService into "auth enabled" mode.
	return {
		countActiveApiKeys: async () => 1,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
}

describe("AuthService — session-account endpoint exemption (#318)", () => {
	describe("isStaticPathExempt", () => {
		it("exempts GET /api/sessions/:id/account", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(
				auth.isStaticPathExempt("/api/sessions/session-abc/account", "GET"),
			).toBe(true);
		});

		it("exempts when method is omitted (mirrors other static exemptions)", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/api/sessions/session-abc/account")).toBe(
				true,
			);
		});

		it("does not exempt POST to the same path", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(
				auth.isStaticPathExempt("/api/sessions/session-abc/account", "POST"),
			).toBe(false);
		});

		it("does not exempt a structurally different /api/sessions path", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(
				auth.isStaticPathExempt("/api/sessions/session-abc/other", "GET"),
			).toBe(false);
		});

		it("does not exempt a shorter /api/sessions path", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/api/sessions/account", "GET")).toBe(
				false,
			);
		});

		it("does not exempt a longer /api/sessions path", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(
				auth.isStaticPathExempt(
					"/api/sessions/session-abc/account/extra",
					"GET",
				),
			).toBe(false);
		});
	});

	describe("isPathExempt / authenticateRequest end-to-end", () => {
		it("allows an unauthenticated GET even when API-key auth is enabled", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			const req = new Request(
				"http://localhost/api/sessions/session-abc/account",
			);
			const result = await auth.authenticateRequest(
				req,
				"/api/sessions/session-abc/account",
				"GET",
			);
			expect(result.isAuthenticated).toBe(true);
		});

		it("still requires auth for a POST to the same path", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			const req = new Request(
				"http://localhost/api/sessions/session-abc/account",
				{ method: "POST" },
			);
			const result = await auth.authenticateRequest(
				req,
				"/api/sessions/session-abc/account",
				"POST",
			);
			expect(result.isAuthenticated).toBe(false);
		});
	});
});
