import { describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { resetApiKeySpend } from "../api-key";

describe("API key CLI spend reset", () => {
	it("persists the reset before notifying local counters with the local-control header", async () => {
		let saved: unknown[] | undefined;
		const db = {
			getApiKey: async () => null,
			getApiKeyByName: async () => ({ id: "key/id", name: "limited" }),
			resetApiKeySpend: async (...args: unknown[]) => {
				saved = args;
				return true;
			},
		} as unknown as DatabaseOperations;
		const config = {
			getRuntime: () => ({ port: 9876 }),
			getLocalControlSecret: () => "test-only-control-secret",
		} as unknown as Config;
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			expect(saved).toBeDefined();
			requests.push({ url: String(url), init });
			return new Response("{}", { status: requests.length === 1 ? 200 : 503 });
		}) as typeof fetch);
		try {
			const before = Date.now();
			const result = await resetApiKeySpend(db, "limited", config);
			expect(saved?.[0]).toBe("key/id");
			expect(saved?.[1]).toBeGreaterThanOrEqual(before);
			expect(saved?.[2]).toBe("CLI");
			expect(result.notified).toBe(true);
			expect(requests.map((request) => request.url)).toEqual([
				"http://localhost:9876/api/api-keys/key%2Fid/reload-spend",
				"http://localhost:8080/api/api-keys/key%2Fid/reload-spend",
				"http://localhost:8081/api/api-keys/key%2Fid/reload-spend",
			]);
			for (const request of requests) {
				expect(request.init?.method).toBe("POST");
				expect(
					new Headers(request.init?.headers).get(
						"x-better-ccflare-local-control-secret",
					),
				).toBe("test-only-control-secret");
			}
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
