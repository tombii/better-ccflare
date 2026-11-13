import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { resetNanoGPTPricingCacheForTest } from "@better-ccflare/core";
import type { ApiKey } from "@better-ccflare/types";
import { APIRouter } from "../../router";
import { AuthService } from "../../services/auth-service";
import type { APIContext } from "../../types";

afterEach(() => resetNanoGPTPricingCacheForTest());

describe("admin model prices endpoint", () => {
	it("serves catalogue rates to admins and rejects API-only keys", async () => {
		const context = {
			dbOps: { getAdapter: () => ({}), onRequestsDeleted: () => () => {} },
			config: {},
		} as unknown as APIContext;
		const auth = spyOn(AuthService.prototype, "authenticateRequest");
		const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [] })),
		);
		const offline = process.env.CF_PRICING_OFFLINE;
		process.env.CF_PRICING_OFFLINE = "1";
		try {
			const router = new APIRouter(context);
			const url = new URL("http://localhost/api/model-prices");
			auth.mockResolvedValue({
				isAuthenticated: true,
				apiKey: { role: "admin" } as ApiKey,
			});
			const response = await router.handleRequest(url, new Request(url));
			expect(response?.status).toBe(200);
			const body = await response?.json();
			expect(body).toMatchObject({
				currency: "USD",
				unit: "per_million_tokens",
			});
			expect(
				body.models.some((model: { rates: unknown }) => model.rates !== null),
			).toBe(true);
			auth.mockResolvedValue({
				isAuthenticated: true,
				apiKey: { role: "api-only" } as ApiKey,
			});
			const denied = await router.handleRequest(url, new Request(url));
			expect(denied?.status).toBe(401);
			expect(await denied?.text()).not.toContain('"models"');
		} finally {
			auth.mockRestore();
			fetch.mockRestore();
			if (offline === undefined) delete process.env.CF_PRICING_OFFLINE;
			else process.env.CF_PRICING_OFFLINE = offline;
		}
	});
});
