/**
 * Tests for the internal-probe exemption added to AuthService (issue #216,
 * stage 1). Auto-refresh-scheduler.ts and cache-keepalive-scheduler.ts
 * self-loop over HTTP to `localhost:{port}/v1/messages` (or the cached
 * request's path) to probe/refresh accounts. When API-key auth is enabled,
 * these synthetic internal requests were 401'd because they never carried an
 * API key — only the process-local internal-probe-secret marker headers
 * already used deeper in the proxy pipeline (see proxy-types.ts
 * isInternalProbe).
 *
 * This suite verifies AuthService.authenticateRequest/isPathExempt now
 * exempts correctly-marked internal probe requests to proxy endpoints
 * (/v1/*, /messages/*) when constructed with a matching internalProbeSecret,
 * and fails closed (still requires an API key) when the secret is wrong,
 * missing, or the marker header is absent.
 */
import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "../auth-service";

const INTERNAL_PROBE_SECRET_HEADER = "x-better-ccflare-internal-probe-secret";
const SECRET = "test-internal-probe-secret";

function makeDbOpsWithApiKeys(): DatabaseOperations {
	// countActiveApiKeys() > 0 is what flips AuthService into "auth enabled" mode.
	return {
		countActiveApiKeys: async () => 1,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
}

function makeRequest(
	path: string,
	headers: Record<string, string> = {},
): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers,
	});
}

describe("AuthService — internal probe exemption (#216)", () => {
	describe("auto-refresh marker", () => {
		it("exempts a request to /v1/messages with matching secret + auto-refresh marker", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET);
			const req = makeRequest("/v1/messages", {
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-auto-refresh": "true",
			});

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages",
				"POST",
			);

			expect(result.isAuthenticated).toBe(true);
		});
	});

	describe("keepalive marker", () => {
		it("exempts a request to /v1/messages with matching secret + keepalive marker", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET);
			const req = makeRequest("/v1/messages", {
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-keepalive": "true",
			});

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages",
				"POST",
			);

			expect(result.isAuthenticated).toBe(true);
		});

		it("exempts a keepalive replay to an arbitrary cached path under /v1", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET);
			const req = makeRequest("/v1/messages/count_tokens", {
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-keepalive": "true",
			});

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages/count_tokens",
				"POST",
			);

			expect(result.isAuthenticated).toBe(true);
		});
	});

	describe("fail-closed behavior", () => {
		it("rejects when the secret is wrong", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET);
			const req = makeRequest("/v1/messages", {
				[INTERNAL_PROBE_SECRET_HEADER]: "wrong-secret",
				"x-better-ccflare-auto-refresh": "true",
			});

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages",
				"POST",
			);

			expect(result.isAuthenticated).toBe(false);
		});

		it("rejects when the secret header is missing entirely", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET);
			const req = makeRequest("/v1/messages", {
				"x-better-ccflare-auto-refresh": "true",
			});

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages",
				"POST",
			);

			expect(result.isAuthenticated).toBe(false);
		});

		it("rejects when the secret matches but no marker header is present", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET);
			const req = makeRequest("/v1/messages", {
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
			});

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages",
				"POST",
			);

			expect(result.isAuthenticated).toBe(false);
		});

		it("rejects when AuthService was constructed without an internalProbeSecret at all", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), undefined);
			const req = makeRequest("/v1/messages", {
				[INTERNAL_PROBE_SECRET_HEADER]: "anything",
				"x-better-ccflare-auto-refresh": "true",
			});

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages",
				"POST",
			);

			expect(result.isAuthenticated).toBe(false);
		});

		it("does not exempt non-proxy paths (e.g. /api/accounts) even with valid probe headers", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET);
			const req = makeRequest("/api/accounts", {
				[INTERNAL_PROBE_SECRET_HEADER]: SECRET,
				"x-better-ccflare-auto-refresh": "true",
			});

			const result = await auth.authenticateRequest(
				req,
				"/api/accounts",
				"GET",
			);

			expect(result.isAuthenticated).toBe(false);
		});
	});

	describe("local-control-secret exemption for CLI notify endpoints", () => {
		const LOCAL_CONTROL_SECRET_HEADER = "x-better-ccflare-local-control-secret";
		const CONTROL_SECRET = "test-local-control-secret";

		it("exempts /api/accounts/:id/reload with a matching local-control-secret", async () => {
			const auth = new AuthService(
				makeDbOpsWithApiKeys(),
				SECRET,
				CONTROL_SECRET,
			);
			const req = makeRequest("/api/accounts/acc-1/reload", {
				[LOCAL_CONTROL_SECRET_HEADER]: CONTROL_SECRET,
			});

			const result = await auth.authenticateRequest(
				req,
				"/api/accounts/acc-1/reload",
				"POST",
			);

			expect(result.isAuthenticated).toBe(true);
		});

		it("exempts /api/accounts/:id/force-reset-rate-limit with a matching local-control-secret", async () => {
			const auth = new AuthService(
				makeDbOpsWithApiKeys(),
				SECRET,
				CONTROL_SECRET,
			);
			const req = makeRequest("/api/accounts/acc-1/force-reset-rate-limit", {
				[LOCAL_CONTROL_SECRET_HEADER]: CONTROL_SECRET,
			});

			const result = await auth.authenticateRequest(
				req,
				"/api/accounts/acc-1/force-reset-rate-limit",
				"POST",
			);

			expect(result.isAuthenticated).toBe(true);
		});

		it("rejects a wrong local-control-secret on the reload endpoint", async () => {
			const auth = new AuthService(
				makeDbOpsWithApiKeys(),
				SECRET,
				CONTROL_SECRET,
			);
			const req = makeRequest("/api/accounts/acc-1/reload", {
				[LOCAL_CONTROL_SECRET_HEADER]: "wrong",
			});

			const result = await auth.authenticateRequest(
				req,
				"/api/accounts/acc-1/reload",
				"POST",
			);

			expect(result.isAuthenticated).toBe(false);
		});

		it("does not leak the local-control-secret exemption to unrelated /api routes", async () => {
			const auth = new AuthService(
				makeDbOpsWithApiKeys(),
				SECRET,
				CONTROL_SECRET,
			);
			const req = makeRequest("/api/accounts/acc-1/pause", {
				[LOCAL_CONTROL_SECRET_HEADER]: CONTROL_SECRET,
			});

			const result = await auth.authenticateRequest(
				req,
				"/api/accounts/acc-1/pause",
				"POST",
			);

			expect(result.isAuthenticated).toBe(false);
		});

		it("rejects when AuthService was constructed without a localControlSecret at all", async () => {
			const auth = new AuthService(makeDbOpsWithApiKeys(), SECRET, undefined);
			const req = makeRequest("/api/accounts/acc-1/reload", {
				[LOCAL_CONTROL_SECRET_HEADER]: "anything",
			});

			const result = await auth.authenticateRequest(
				req,
				"/api/accounts/acc-1/reload",
				"POST",
			);

			expect(result.isAuthenticated).toBe(false);
		});
	});

	describe("auth disabled (no active API keys) — unaffected baseline", () => {
		it("still allows plain requests through when no API keys are configured", async () => {
			const dbOps = {
				countActiveApiKeys: async () => 0,
				getActiveApiKeys: async () => [],
			} as unknown as DatabaseOperations;
			const auth = new AuthService(dbOps, SECRET);
			const req = makeRequest("/v1/messages");

			const result = await auth.authenticateRequest(
				req,
				"/v1/messages",
				"POST",
			);

			expect(result.isAuthenticated).toBe(true);
		});
	});
});
