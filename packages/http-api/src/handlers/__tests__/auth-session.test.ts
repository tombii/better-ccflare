import { describe, expect, it, spyOn } from "bun:test";
import type { ApiKey } from "@better-ccflare/types";
import { APIRouter } from "../../router";
import { AuthService } from "../../services/auth-service";
import type { APIContext } from "../../types";

describe("authenticated dashboard session", () => {
	it("returns only the caller identity for admins, API-only keys, and local no-auth mode", async () => {
		const auth = spyOn(AuthService.prototype, "authenticateRequest");
		try {
			const router = new APIRouter({
				dbOps: { getAdapter: () => ({}), onRequestsDeleted: () => () => {} },
				config: {},
			} as unknown as APIContext);
			const url = new URL("http://local/api/auth/session");
			for (const role of ["admin", "api-only"] as const) {
				auth.mockResolvedValue({
					isAuthenticated: true,
					apiKeyId: "own",
					role,
					apiKey: { role } as ApiKey,
				});
				const response = await router.handleRequest(url, new Request(url));
				expect(response?.status).toBe(200);
				expect(await response?.json()).toEqual({
					canManage: role === "admin",
					apiKeyId: "own",
				});
			}
			auth.mockResolvedValue({ isAuthenticated: true });
			expect(
				await (await router.handleRequest(url, new Request(url)))?.json(),
			).toEqual({ canManage: true, apiKeyId: null });
			auth.mockResolvedValue({
				isAuthenticated: false,
				error: "Invalid API key",
			});
			expect((await router.handleRequest(url, new Request(url)))?.status).toBe(
				401,
			);
		} finally {
			auth.mockRestore();
		}
	});
});
