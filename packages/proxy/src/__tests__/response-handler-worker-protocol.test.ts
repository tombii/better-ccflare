import { describe, expect, it, mock, spyOn } from "bun:test";
import { forwardToClient } from "../response-handler";
import * as usageCollectorModule from "../usage-collector";

describe("forwardToClient usage-collector protocol", () => {
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

	function createMockCollector() {
		const starts: Record<string, unknown>[] = [];
		const chunks: Array<{ requestId: string; data: Uint8Array }> = [];
		const ends: Record<string, unknown>[] = [];

		const collector = {
			handleStart: mock((msg: Record<string, unknown>) => {
				starts.push(msg);
			}),
			handleChunk: mock((requestId: string, data: Uint8Array) => {
				chunks.push({ requestId, data });
			}),
			handleEnd: mock((msg: Record<string, unknown>) => {
				ends.push(msg);
				return Promise.resolve();
			}),
		};

		// Spy on getUsageCollector to return our mock
		const spy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		return { collector, starts, chunks, ends, spy };
	}

	function createCtx(storePayloads = true) {
		return {
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
		} as unknown as import("../handlers").ProxyContext;
	}

	it("calls handleStart with messageId", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx();

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
		expect(starts.length).toBeGreaterThan(0);
		expect(starts[0].type).toBe("start");
		expect(typeof starts[0].messageId).toBe("string");
		expect((starts[0].messageId as string).length).toBeGreaterThan(0);
	});

	it("sends null requestBody when payload storage is disabled", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx(false);

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

		expect(starts[0].type).toBe("start");
		expect(starts[0].requestBody).toBeNull();
		expect(starts[0].project).toBe("main-thread-project");
	});

	it("preserves requestBody when payload storage is enabled", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx(true);
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

		expect(starts[0].type).toBe("start");
		expect(starts[0].requestBody).toBe(
			Buffer.from(requestBody).toString("base64"),
		);
		expect(starts[0].project).toBeNull();
	});

	it("does not throw when usage collector call succeeds", async () => {
		createMockCollector();
		const ctx = createCtx();

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

	it("tees streaming responses instead of cloning", async () => {
		const originalClone = Response.prototype.clone;
		Response.prototype.clone = mock(() => {
			throw new Error("clone should not be called");
		}) as unknown as typeof Response.prototype.clone;

		try {
			const { starts, chunks, ends } = createMockCollector();
			const ctx = createCtx();
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
			await waitFor(() => ends.length > 0);

			expect(chunks.length).toBe(2);
			expect(starts[0]).toMatchObject({
				type: "start",
				requestId: "req-stream-tee",
			});
			expect(ends[0]).toMatchObject({
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
			const { ends } = createMockCollector();
			const ctx = createCtx();
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
			await waitFor(() => ends.length > 0);

			expect(ends[0]).toMatchObject({
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
