/**
 * Regression coverage for two auth bypasses previously present in
 * isStaticPathExempt():
 *
 * 1. OAuth token-mutation bypass — every /api/oauth* path was blanket-exempt,
 *    so an unauthenticated caller could POST to init/reauth/callback and
 *    overwrite stored account OAuth tokens even with dashboard auth enabled.
 *
 * 2. Arbitrary-path proxy bypass — any path not starting with /api, /v1, or
 *    /messages was exempt (intended to let the dashboard serve its SPA/static
 *    assets). But this exemption lives in the SAME isPathExempt() consulted
 *    by the proxy fallback in apps/server/src/server.ts, so when the
 *    dashboard was disabled or its assets were unavailable, an arbitrary
 *    request (e.g. POST /foo) reached the upstream proxy handler
 *    unauthenticated.
 *
 * The fix removes both blanket exemptions. OAuth read-only status polling
 * (GET /api/oauth/{qwen,codex}/status/*) remains exempt. The dashboard SPA
 * and static assets are now served by the server BEFORE authentication is
 * consulted at all (server.ts), so nothing legitimate needs an exemption at
 * this layer for non-API paths.
 */
import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "../auth-service";

function makeDbOpsNoKeys(): DatabaseOperations {
	return {
		countActiveApiKeys: async () => 0,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
}

function makeDbOpsWithApiKeys(): DatabaseOperations {
	return {
		countActiveApiKeys: async () => 1,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
}

describe("AuthService — static exemption bypass regression", () => {
	describe("OAuth endpoints", () => {
		it("isStaticPathExempt no longer blanket-exempts /api/oauth*", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/api/oauth/init")).toBe(false);
			expect(auth.isStaticPathExempt("/api/oauth/callback")).toBe(false);
			expect(auth.isStaticPathExempt("/api/oauth/qwen/reauth")).toBe(false);
		});

		it("isPathExempt rejects token-mutating OAuth paths when auth is enabled", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(await auth.isPathExempt("/api/oauth/init", "POST")).toBe(false);
			expect(await auth.isPathExempt("/api/oauth/callback", "POST")).toBe(
				false,
			);
			expect(await auth.isPathExempt("/api/oauth/qwen/reauth", "POST")).toBe(
				false,
			);
			expect(await auth.isPathExempt("/api/oauth/codex/reauth", "POST")).toBe(
				false,
			);
			expect(
				await auth.isPathExempt("/api/oauth/anthropic/reauth/callback", "POST"),
			).toBe(false);
		});

		it("isPathExempt still allows read-only OAuth status polling", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(
				await auth.isPathExempt("/api/oauth/qwen/status/acct-1", "GET"),
			).toBe(true);
			expect(
				await auth.isPathExempt("/api/oauth/codex/status/acct-1", "GET"),
			).toBe(true);
		});

		it("does not exempt a POST to the status-polling path", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(
				await auth.isPathExempt("/api/oauth/qwen/status/acct-1", "POST"),
			).toBe(false);
		});

		it("authenticateRequest rejects unauthenticated OAuth mutation once keys exist", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			const req = new Request("http://localhost/api/oauth/callback", {
				method: "POST",
			});
			const result = await auth.authenticateRequest(
				req,
				"/api/oauth/callback",
				"POST",
			);
			expect(result.isAuthenticated).toBe(false);
		});

		it("authenticateRequest still allows OAuth init during initial setup (no keys yet)", async () => {
			const auth = new AuthService(makeDbOpsNoKeys());
			const req = new Request("http://localhost/api/oauth/init", {
				method: "POST",
			});
			const result = await auth.authenticateRequest(
				req,
				"/api/oauth/init",
				"POST",
			);
			expect(result.isAuthenticated).toBe(true);
		});
	});

	describe("Arbitrary non-API paths", () => {
		it("isStaticPathExempt no longer exempts an arbitrary non-API path", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/foo")).toBe(false);
			expect(auth.isStaticPathExempt("/dashboard")).toBe(false);
			expect(auth.isStaticPathExempt("/")).toBe(false);
			expect(auth.isStaticPathExempt("/static/logo.png")).toBe(false);
		});

		it("isPathExempt rejects an arbitrary non-API path when auth is enabled", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(await auth.isPathExempt("/foo", "POST")).toBe(false);
			expect(await auth.isPathExempt("/anything/else", "GET")).toBe(false);
		});

		it("authenticateRequest rejects an unauthenticated proxy-fallback path once keys exist", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			const req = new Request("http://localhost/foo", { method: "POST" });
			const result = await auth.authenticateRequest(req, "/foo", "POST");
			expect(result.isAuthenticated).toBe(false);
		});

		it("/health remains statically exempt", () => {
			const auth = new AuthService(makeDbOpsWithApiKeys());
			expect(auth.isStaticPathExempt("/health")).toBe(true);
		});
	});
});
