import { describe, expect, it, mock } from "bun:test";
import { forwardToClient } from "../response-handler";

describe("forwardToClient worker protocol", () => {
	it("sends start message with messageId", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const usageWorker = {
			postMessage: mock((msg: Record<string, unknown>) => {
				posted.push(msg);
			}),
		} as unknown as import("../usage-worker-controller").UsageWorkerController;

		const ctx = {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: {},
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
			usageWorker,
		} as unknown as import("../handlers").ProxyContext;

		const response = await forwardToClient(
			{
				requestId: "req-1",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		expect(response.status).toBe(200);
		expect(usageWorker.postMessage).toHaveBeenCalled();
		expect(posted.length).toBeGreaterThan(0);
		expect(posted[0].type).toBe("start");
		expect(typeof posted[0].messageId).toBe("string");
		expect((posted[0].messageId as string).length).toBeGreaterThan(0);
	});

	it("does not throw when worker is not ready", async () => {
		const usageWorker = {
			postMessage: mock(() => {
				throw new Error("worker not ready");
			}),
		} as unknown as import("../usage-worker-controller").UsageWorkerController;

		const ctx = {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: {},
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
			usageWorker,
		} as unknown as import("../handlers").ProxyContext;

		await expect(
			forwardToClient(
				{
					requestId: "req-2",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			),
		).resolves.toBeInstanceOf(Response);
	});
});
