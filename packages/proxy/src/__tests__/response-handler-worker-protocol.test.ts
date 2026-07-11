import { describe, expect, it, mock, spyOn } from "bun:test";
import { requestEvents } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import * as modelCatalogModule from "../model-catalog";
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

	it("non-streaming request with project+agent sources set in options produces a StartMessage carrying both source labels", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx();

		await forwardToClient(
			{
				requestId: "req-sources-non-stream",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				project: "acme-project",
				projectAttributionSource: "header_project",
				response: new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				agentUsed: "code-reviewer",
				agentAttributionSource: "prompt_agent",
			},
			ctx,
		);

		expect(starts[0].projectAttributionSource).toBe("header_project");
		expect(starts[0].agentAttributionSource).toBe("prompt_agent");
	});

	it("streaming request with project+agent sources set in options produces a StartMessage carrying both source labels", async () => {
		const { starts, ends } = createMockCollector();
		const ctx = createCtx();
		ctx.provider.isStreamingResponse = () => true;

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: one\n\n"));
				controller.close();
			},
		});

		const response = await forwardToClient(
			{
				requestId: "req-sources-stream",
				method: "POST",
				path: "/v1/messages",
				account: null,
				requestHeaders: new Headers({ "content-type": "application/json" }),
				requestBody: new TextEncoder().encode("{}"),
				project: "acme-project",
				projectAttributionSource: "path_project",
				response: new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
				agentUsed: "code-reviewer",
				agentAttributionSource: "header_agent",
			},
			ctx,
		);

		await response.text();
		await waitFor(() => ends.length > 0);

		expect(starts[0].projectAttributionSource).toBe("path_project");
		expect(starts[0].agentAttributionSource).toBe("header_agent");
	});

	it("defaults source labels to 'none' when options omit them", async () => {
		const { starts } = createMockCollector();
		const ctx = createCtx();

		await forwardToClient(
			{
				requestId: "req-sources-default",
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

		expect(starts[0].projectAttributionSource).toBe("none");
		expect(starts[0].agentAttributionSource).toBe("none");
	});

	it("SSE start event includes agentAttributionSource", async () => {
		const { collector: _collector } = createMockCollector();
		const ctx = createCtx();

		const events: Array<Record<string, unknown>> = [];
		const listener = (evt: Record<string, unknown>) => {
			if (evt.type === "start") events.push(evt);
		};
		requestEvents.on("event", listener);

		try {
			await forwardToClient(
				{
					requestId: "req-sse-source",
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
					agentUsed: "code-reviewer",
					agentAttributionSource: "header_agent",
				},
				ctx,
			);

			expect(events.length).toBeGreaterThan(0);
			expect(events[0].agentAttributionSource).toBe("header_agent");
		} finally {
			requestEvents.off("event", listener);
		}
	});

	it("accepts a legacy StartMessage without source fields without throwing, leaving them undefined", () => {
		const { collector, starts } = createMockCollector();

		// Simulates a message built by an older worker/producer that predates
		// the projectAttributionSource/agentAttributionSource fields. Both are
		// optional on StartMessage precisely so this legacy shape still type-checks.
		const legacyStartMessage: import("../worker-messages").StartMessage = {
			type: "start",
			messageId: "legacy-msg-1",
			requestId: "req-legacy",
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {},
			isStream: false,
			providerName: "anthropic",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			comboName: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};

		expect(() => collector.handleStart(legacyStartMessage)).not.toThrow();
		expect(starts[0].projectAttributionSource).toBeUndefined();
		expect(starts[0].agentAttributionSource).toBeUndefined();
	});
});

describe("forwardToClient passive model-catalog capture", () => {
	function createIngestSpy() {
		return spyOn(modelCatalogModule, "ingestModelsListing").mockResolvedValue(
			undefined,
		);
	}

	function makeAccount(overrides: Partial<Account> = {}): Account {
		return {
			id: "acc-1",
			name: "test-console-account",
			provider: "claude-console-api",
			api_key: "sk-test",
			refresh_token: "rt",
			access_token: null,
			expires_at: null,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			rate_limited_reason: null,
			rate_limited_at: null,
			session_start: null,
			session_request_count: 0,
			paused: false,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			auto_pause_on_overage_enabled: false,
			peak_hours_pause_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
			cross_region_mode: null,
			model_fallbacks: null,
			billing_type: null,
			pause_reason: null,
			refresh_token_issued_at: null,
			consecutive_rate_limits: 0,
			...overrides,
		};
	}

	function createCtx() {
		return {
			strategy: {},
			dbOps: {},
			runtime: { port: 8080, tlsEnabled: false },
			config: { getStorePayloads: () => true },
			provider: {
				name: "anthropic",
				isStreamingResponse: () => false,
			},
			refreshInFlight: new Map<string, Promise<string>>(),
			asyncWriter: {},
		} as unknown as import("../handlers").ProxyContext;
	}

	it("captures a GET /v1/models 200 response with an account present", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();
			const bodyText = JSON.stringify({
				data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
				has_more: false,
			});

			const response = await forwardToClient(
				{
					requestId: "req-capture-1",
					method: "GET",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
					query: "?after_id=model-a",
					response: new Response(bodyText, {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).toHaveBeenCalledTimes(1);
			expect(ingestSpy).toHaveBeenCalledWith(
				bodyText,
				account,
				"?after_id=model-a",
			);
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture a non-GET response", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();

			const response = await forwardToClient(
				{
					requestId: "req-capture-post",
					method: "POST",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
					response: new Response(JSON.stringify({ data: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture a non-200 response", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();

			const response = await forwardToClient(
				{
					requestId: "req-capture-500",
					method: "GET",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
					response: new Response(JSON.stringify({ error: "boom" }), {
						status: 500,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture a streaming response", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const account = makeAccount();
			const ctx = createCtx();
			ctx.provider.isStreamingResponse = () => true;

			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"data":[]}'));
					controller.close();
				},
			});

			const response = await forwardToClient(
				{
					requestId: "req-capture-stream",
					method: "GET",
					path: "/v1/models",
					account,
					requestHeaders: new Headers(),
					requestBody: null,
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
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("does not capture when no account is present", async () => {
		const ingestSpy = createIngestSpy();
		try {
			const ctx = createCtx();

			const response = await forwardToClient(
				{
					requestId: "req-capture-no-account",
					method: "GET",
					path: "/v1/models",
					account: null,
					requestHeaders: new Headers(),
					requestBody: null,
					response: new Response(JSON.stringify({ data: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
				},
				ctx,
			);
			await response.text();

			expect(ingestSpy).not.toHaveBeenCalled();
		} finally {
			ingestSpy.mockRestore();
		}
	});

	it("delivers the client response unaffected by a malformed capture body (real ingestModelsListing, no mock)", async () => {
		const account = makeAccount();
		const ctx = createCtx();
		const malformedBody = "{not valid json";

		const response = await forwardToClient(
			{
				requestId: "req-capture-malformed",
				method: "GET",
				path: "/v1/models",
				account,
				requestHeaders: new Headers(),
				requestBody: null,
				response: new Response(malformedBody, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			ctx,
		);

		await expect(response.text()).resolves.toBe(malformedBody);
	});
});
