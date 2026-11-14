import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "../auth-service";

describe("local cost-tracking reload authentication", () => {
	it("honors a local-control secret only for POST", async () => {
		const auth = new AuthService(
			{ countActiveApiKeys: async () => 1 } as unknown as DatabaseOperations,
			undefined,
			"local-secret",
		);
		const path = "/api/config/cost-tracking/reload";
		for (const method of ["POST", "GET", "DELETE", "PUT", "PATCH"]) {
			const request = new Request(`http://localhost${path}`, {
				method,
				headers: { "x-better-ccflare-local-control-secret": "local-secret" },
			});
			expect(
				(await auth.authenticateRequest(request, path, method)).isAuthenticated,
			).toBe(method === "POST");
		}
	});
});
