import { describe, expect, it, mock } from "bun:test";
import { forwardToClient } from "../response-handler";

describe("forwardToClient worker protocol", () => {
	async function waitFor(
		predicate: () => boolean,
		timeoutMs = 1000,
	): Promise<void> {
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) {
				throw new Error("Timed out waiting for condition");
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function createCtx(
		postMessage: (msg: Record<string, unknown>) => void,
		storePayloads = true,
	) {
		const usageWorker = {
			postMessage: mock(postMessage),
		} as unknown as import("../usage-worker-controller").UsageWorkerController;

		const ctx = {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: {
				getStorePayloads: () => storePayloads,
			},
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
			usageWorker,
		} as unknown as import("../handlers").ProxyContext;

		return { ctx, usageWorker };
	}

	it("sends start message with messageId", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const { ctx, usageWorker } = createCtx((msg) => posted.push(msg));

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

	it("sends null requestBody when payload storage is disabled", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const { ctx } = createCtx((msg) => posted.push(msg), false);

		await forwardToClient(
			{
				requestId: "req-no-payload",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(
					JSON.stringify({ system: "test", messages: [] }),
				),
				project: "main-thread-project",
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

		expect(posted[0].type).toBe("start");
		expect(posted[0].requestBody).toBeNull();
		expect(posted[0].project).toBe("main-thread-project");
	});

	it("preserves requestBody when payload storage is enabled", async () => {
		const posted: Array<Record<string, unknown>> = [];
		const { ctx } = createCtx((msg) => posted.push(msg), true);
		const requestBody = JSON.stringify({ system: "test", messages: [] });

		await forwardToClient(
			{
				requestId: "req-payload",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode(requestBody),
				project: null,
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

		expect(posted[0].type).toBe("start");
		expect(posted[0].requestBody).toBe(
			Buffer.from(requestBody).toString("base64"),
		);
		expect(posted[0].project).toBeNull();
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

	it("tees streaming responses instead of cloning when no analytics stream exists", async () => {
		const originalClone = Response.prototype.clone;
		Response.prototype.clone = mock(() => {
			throw new Error("clone should not be called");
		}) as unknown as typeof Response.prototype.clone;

		try {
			const posted: Array<Record<string, unknown>> = [];
			const { ctx } = createCtx((msg) => posted.push(msg));
			ctx.provider.isStreamingResponse = () => true;

			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode("data: one\n\n"));
					controller.enqueue(encoder.encode("data: two\n\n"));
					controller.close();
				},
			});

			const response = await forwardToClient(
				{
					requestId: "req-stream-tee",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(body, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);

			await expect(response.text()).resolves.toBe("data: one\n\ndata: two\n\n");
			await waitFor(() => posted.some((msg) => msg.type === "end"));

			const chunks = posted.filter((msg) => msg.type === "chunk");
			expect(chunks.length).toBe(2);
			expect(posted.at(-1)).toMatchObject({
				type: "end",
				requestId: "req-stream-tee",
				success: true,
			});
		} finally {
			Response.prototype.clone = originalClone;
		}
	});

	it("tees non-streaming responses instead of cloning analytics body", async () => {
		const originalClone = Response.prototype.clone;
		Response.prototype.clone = mock(() => {
			throw new Error("clone should not be called");
		}) as unknown as typeof Response.prototype.clone;

		try {
			const posted: Array<Record<string, unknown>> = [];
			const { ctx } = createCtx((msg) => posted.push(msg));
			const responseBody = JSON.stringify({ ok: true });

			const response = await forwardToClient(
				{
					requestId: "req-non-stream-tee",
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({ "content-type": "application/json" }),
					requestBody: new TextEncoder().encode("{}"),
					response: new Response(responseBody, {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);

			await expect(response.text()).resolves.toBe(responseBody);
			await waitFor(() => posted.some((msg) => msg.type === "end"));

			expect(posted.at(-1)).toMatchObject({
				type: "end",
				requestId: "req-non-stream-tee",
				responseBody: Buffer.from(responseBody).toString("base64"),
				success: true,
			});
		} finally {
			Response.prototype.clone = originalClone;
		}
	});
});
