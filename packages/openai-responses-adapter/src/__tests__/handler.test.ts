import { describe, expect, test } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-haiku-4-5",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
});

describe("handleResponsesRequest", () => {
	test("Test 1: invalid request (no input field) → 400", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("should not be called", { status: 200 });

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "claude-haiku-4-5" }), // no input
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(400);

		const body = await resp.json();
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
	});

	test("Test 2: non-streaming path → calls handleProxy with /v1/messages, returns translated response", async () => {
		let capturedUrl: URL | null = null;

		const mockHandleProxy: HandleProxyFn = async (_req, url) => {
			capturedUrl = url;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);

		expect(capturedUrl?.pathname).toBe("/v1/messages");
		expect(resp.status).toBe(200);

		const body = await resp.json();
		expect(body.object).toBe("response");
		expect(Array.isArray(body.output)).toBe(true);
		expect(body.output[0].type).toBe("message");
	});

	test("surfaces Codex CLI session identity as metadata.user_id", async () => {
		let forwardedBody: Record<string, unknown> | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2) => {
			forwardedBody = (await req2.json()) as Record<string, unknown>;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const makeReq = (extra: Record<string, unknown>) =>
			new Request("http://localhost/v1/responses", {
				method: "POST",
				body: JSON.stringify({
					model: "claude-haiku-4-5",
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "Hi" }],
						},
					],
					stream: false,
					...extra,
				}),
				headers: { "Content-Type": "application/json" },
			});

		// prompt_cache_key is Codex CLI's stable conversation identity; without
		// surfacing it, /v1/responses traffic is anonymous to the session
		// governor and load-balancer session affinity.
		const req = makeReq({ prompt_cache_key: "conv-abc123" });
		await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
			"api-key-record-123",
		);
		expect(
			(forwardedBody as unknown as { metadata?: { user_id?: string } })
				?.metadata?.user_id,
		).toBe("codex-responses-conv-abc123");

		// Without any identity the body stays metadata-free (anonymous).
		const anonReq = makeReq({});
		await handleResponsesRequest(
			anonReq,
			new URL(anonReq.url),
			mockHandleProxy,
			{},
		);
		expect(
			(forwardedBody as unknown as { metadata?: unknown })?.metadata,
		).toBeUndefined();
	});

	test("preserves native continuation/cache controls and normalizes gateway identity headers", async () => {
		let forwardedBody: Record<string, unknown> | null = null;
		let forwardedHeaders: Headers | null = null;
		let forwardedOptions: { trustedNativeResponses?: boolean } | undefined;
		const mockHandleProxy: HandleProxyFn = async (
			req2,
			_url,
			_ctx,
			_apiKeyId,
			_apiKeyName,
			options,
		) => {
			forwardedBody = (await req2.json()) as Record<string, unknown>;
			forwardedHeaders = new Headers(req2.headers);
			forwardedOptions = options;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		const nativeInput = [
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "stable policy" }],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "next turn" }],
			},
		];
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: nativeInput,
				stream: false,
				previous_response_id: "resp_previous",
				prompt_cache_key: "stable-cache-key",
				prompt_cache_options: {
					mode: "explicit",
				},
			}),
			headers: {
				"Content-Type": "application/json",
				"X-Better-Ccflare-Codex-Continuation": "previous_response_id",
				"X-Better-Ccflare-Prompt-Cache-Mode": "implicit",
				"X-Better-Ccflare-Prompt-Cache-Ttl": "30m",
				"X-Better-Ccflare-Prompt-Cache-Breakpoint": "developer",
				"X-Better-Ccflare-Session-Id": "session-123",
				"X-Better-Ccflare-Client-Request-Id": "client-request-123",
			},
		});

		await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
			"api-key-record-123",
		);

		const passthrough = (
			forwardedBody as unknown as {
				__better_ccflare_codex_passthrough: Record<string, unknown>;
			}
		).__better_ccflare_codex_passthrough;
		expect(passthrough.previous_response_id).toBe("resp_previous");
		expect(passthrough.caller_identity_digest).toMatch(/^[0-9a-f]{64}$/);
		expect(passthrough.cache_controls_applied).toBe(true);
		expect(JSON.stringify(passthrough)).not.toContain("api-key-record-123");
		expect(passthrough.prompt_cache_options).toEqual({
			ttl: "30m",
		});
		expect(passthrough.native_input).toEqual([
			{
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: "stable policy",
						prompt_cache_breakpoint: { mode: "explicit" },
					},
				],
			},
			nativeInput[1],
		]);
		expect(forwardedHeaders?.get("session-id")).toBe("session-123");
		expect(forwardedHeaders?.get("x-client-request-id")).toBe(
			"client-request-123",
		);
		expect(forwardedHeaders?.get("x-better-ccflare-session-id")).toBeNull();
		expect(
			forwardedHeaders?.get("x-better-ccflare-prompt-cache-mode"),
		).toBeNull();
		expect(forwardedHeaders?.get("x-better-ccflare-native-responses")).toBe(
			"true",
		);
		expect(forwardedOptions).toEqual({ trustedNativeResponses: true });
	});

	test("does not attest cache controls when the exact expected set was not applied", async () => {
		let forwardedBody: Record<string, unknown> | null = null;
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-prompt-cache-mode": "implicit",
				"x-better-ccflare-prompt-cache-ttl": "30m",
			},
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: [{ role: "developer", content: "policy" }],
			}),
		});
		await handleResponsesRequest(
			req,
			new URL(req.url),
			async (forwarded) => {
				forwardedBody = (await forwarded.json()) as Record<string, unknown>;
				return new Response(ANTHROPIC_MESSAGE_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{},
			"api-key-record-123",
		);
		const passthrough = (
			forwardedBody as unknown as {
				__better_ccflare_codex_passthrough: Record<string, unknown>;
			}
		).__better_ccflare_codex_passthrough;
		expect(passthrough.cache_controls_applied).toBeUndefined();
	});

	test("does not attest cache controls with comparison, unknown options, or an inexact breakpoint", async () => {
		for (const [name, promptCacheOptions, breakpoint] of [
			[
				"comparison",
				{ comparison_response_id: "resp_compare" },
				{ mode: "explicit" },
			],
			["unknown", { future_option: true }, { mode: "explicit" }],
			["breakpoint-extra", {}, { mode: "explicit", future_option: true }],
			["breakpoint-invalid", {}, { mode: "implicit" }],
		] as const) {
			let forwardedBody: Record<string, unknown> | null = null;
			const req = new Request(`http://localhost/v1/responses?case=${name}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-prompt-cache-mode": "implicit",
					"x-better-ccflare-prompt-cache-ttl": "30m",
					"x-better-ccflare-prompt-cache-breakpoint": "developer",
				},
				body: JSON.stringify({
					model: "gpt-5.6-sol",
					input: [
						{
							type: "message",
							role: "developer",
							content: [
								{
									type: "input_text",
									text: "policy",
									prompt_cache_breakpoint: breakpoint,
								},
							],
						},
					],
					prompt_cache_options: promptCacheOptions,
				}),
			});
			await handleResponsesRequest(
				req,
				new URL(req.url),
				async (forwarded) => {
					forwardedBody = (await forwarded.json()) as Record<string, unknown>;
					return new Response(ANTHROPIC_MESSAGE_BODY, {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
				{},
				"api-key-record-123",
			);
			const passthrough = (
				forwardedBody as unknown as {
					__better_ccflare_codex_passthrough: Record<string, unknown>;
				}
			).__better_ccflare_codex_passthrough;
			expect(passthrough.cache_controls_applied).toBeUndefined();
		}
	});

	test("preserves native built-in tools and cache-significant execution controls", async () => {
		let forwardedBody: Record<string, unknown> | null = null;
		const nativeTools = [
			{ type: "web_search_preview", search_context_size: "high" },
		];
		const nativeToolChoice = { type: "web_search_preview" };
		const nativeReasoning = {
			effort: "high",
			summary: "detailed",
			context: "this_turn",
		};
		const nativeGenerationFields = {
			text: { format: { type: "json_schema", name: "answer" } },
			temperature: 0.25,
			top_p: 0.8,
			truncation: "auto",
			include: ["reasoning.encrypted_content"],
			metadata: { workflow: "cache-test" },
			service_tier: "priority",
			context_management: [{ type: "compaction", compact_threshold: 100_000 }],
			max_output_tokens: 2048,
			stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
			client_metadata: { "x-codex-turn-metadata": "vscode-test-turn" },
			access_programs: { cyber: "standard" },
		};
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: "find it",
				tools: nativeTools,
				tool_choice: nativeToolChoice,
				parallel_tool_calls: true,
				reasoning: nativeReasoning,
				...nativeGenerationFields,
			}),
		});
		await handleResponsesRequest(
			req,
			new URL(req.url),
			async (forwarded) => {
				forwardedBody = (await forwarded.json()) as Record<string, unknown>;
				return new Response(ANTHROPIC_MESSAGE_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			{},
		);
		const passthrough = (
			forwardedBody as unknown as {
				__better_ccflare_codex_passthrough: Record<string, unknown>;
			}
		).__better_ccflare_codex_passthrough;
		expect(passthrough.tools).toEqual(nativeTools);
		expect(passthrough.tool_choice).toEqual(nativeToolChoice);
		expect(passthrough.parallel_tool_calls).toBe(true);
		expect(passthrough.reasoning).toEqual(nativeReasoning);
		for (const [field, value] of Object.entries(nativeGenerationFields)) {
			expect(passthrough[field]).toEqual(value);
		}
	});

	test("rejects unsupported fields and non-positive native max output before proxying", async () => {
		for (const extra of [{ background: true }, { max_output_tokens: 0 }]) {
			let proxyCalls = 0;
			const req = new Request("http://localhost/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-sol",
					input: "hello",
					...extra,
				}),
			});
			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				async () => {
					proxyCalls++;
					return new Response(ANTHROPIC_MESSAGE_BODY);
				},
				{},
			);
			expect(response.status).toBe(400);
			expect(proxyCalls).toBe(0);
			const error = await response.json();
			expect(error.error.type).toBe("invalid_request_error");
		}
	});

	test("rejects non-object JSON request bodies before field enumeration", async () => {
		for (const body of [null, "hello", 42, []]) {
			let proxyCalls = 0;
			const req = new Request("http://localhost/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				async () => {
					proxyCalls++;
					return new Response(ANTHROPIC_MESSAGE_BODY);
				},
				{},
			);
			expect(response.status).toBe(400);
			expect(proxyCalls).toBe(0);
			const error = await response.json();
			expect(error.error).toEqual({
				type: "invalid_request_error",
				message: "Request body must be a JSON object",
			});
		}
	});

	test("adds one developer breakpoint to the generic pi string-content shape", async () => {
		let forwardedBody: Record<string, unknown> | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2) => {
			forwardedBody = (await req2.json()) as Record<string, unknown>;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-prompt-cache-breakpoint": "developer",
			},
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: [
					{ role: "developer", content: "stable policy" },
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "task" }],
					},
				],
			}),
		});
		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});
		const passthrough = (
			forwardedBody as unknown as {
				__better_ccflare_codex_passthrough: { native_input: unknown[] };
			}
		).__better_ccflare_codex_passthrough;
		expect(passthrough.native_input[0]).toEqual({
			type: "message",
			role: "developer",
			content: [
				{
					type: "input_text",
					text: "stable policy",
					prompt_cache_breakpoint: { mode: "explicit" },
				},
			],
		});
	});

	test("fails closed when a requested developer breakpoint cannot be established", async () => {
		let called = false;
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-prompt-cache-breakpoint": "developer",
			},
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "task" }],
					},
				],
			}),
		});
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			async () => {
				called = true;
				return new Response();
			},
			{},
		);
		expect(response.status).toBe(400);
		expect(called).toBe(false);
		expect(await response.text()).not.toContain("task");
	});

	test("refuses to add a fifth prompt cache breakpoint", async () => {
		const marked = (text: string) => ({
			type: "message",
			role: "user",
			content: [
				{
					type: "input_text",
					text,
					prompt_cache_breakpoint: { mode: "explicit" },
				},
			],
		});
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-prompt-cache-breakpoint": "developer",
			},
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: [
					{ role: "developer", content: "stable policy" },
					marked("one"),
					marked("two"),
					marked("three"),
					marked("four"),
				],
			}),
		});
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			async () => new Response(),
			{},
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("budget is exhausted");
	});

	test("Test 3: error passthrough → if handleProxy returns 429, handler returns 429", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("rate limited", {
				status: 429,
				headers: {
					"x-better-ccflare-codex-response-format": "responses-api",
					"x-better-ccflare-transport-used": "http",
					"x-better-ccflare-continuation-used": "false",
					"x-better-ccflare-previous-response-present": "false",
					"x-better-ccflare-stable-prefix-digest": "a".repeat(64),
					"x-better-ccflare-session-digest": "b".repeat(64),
					"x-better-ccflare-continuation-result": "hit",
					"x-better-ccflare-cache-controls-applied": "true",
				},
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.status).toBe(429);
		expect(resp.headers.get("x-better-ccflare-transport-used")).toBe("http");
		expect(resp.headers.get("x-better-ccflare-stable-prefix-digest")).toBe(
			"a".repeat(64),
		);
		expect(
			resp.headers.get("x-better-ccflare-codex-response-format"),
		).toBeNull();
	});

	test.each([
		{
			upstream: {
				detail: "This model is unavailable for the selected account",
			},
			message: "This model is unavailable for the selected account",
			type: "api_error",
			code: "api_error",
		},
		{
			upstream: {
				error: {
					message: "Account access denied",
					type: "permission_error",
					code: "account_denied",
				},
			},
			message: "Account access denied",
			type: "permission_error",
			code: "account_denied",
		},
		{
			upstream: { error: "Provider rejected the request" },
			message: "Provider rejected the request",
			type: "api_error",
			code: "api_error",
		},
	])("preserves actionable upstream 403 errors: $message", async ({
		upstream,
		message,
		type,
		code,
	}) => {
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-6-astra", input: "Hi" }),
		});
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			async () =>
				new Response(JSON.stringify(upstream), {
					status: 403,
					headers: {
						"content-type": "application/json",
						"content-length": "123",
						"content-encoding": "gzip",
						"x-request-id": "upstream-request-id",
					},
				}),
			{},
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: { message, type, code } });
		expect(response.headers.get("content-length")).toBeNull();
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(response.headers.get("x-request-id")).toBe("upstream-request-id");
	});

	test.each([
		["text/html", "<html>Upstream access denied</html>"],
		["application/json", "invalid JSON"],
		["application/json", "null"],
	])("reports upstream HTTP status for unrecognized %s errors", async (contentType, upstreamBody) => {
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-6-astra", input: "Hi" }),
		});
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			async () =>
				new Response(upstreamBody, {
					status: 403,
					headers: { "content-type": contentType },
				}),
			{},
		);
		const body = await response.json();
		expect(response.status).toBe(403);
		expect(body.error.message).toContain("HTTP 403");
		expect(body.error.message).toContain("proxy request logs");
		expect(body.error.message).not.toContain(upstreamBody);
	});

	test.each([
		true,
		false,
	])("validates non-streaming custom tool bridge input (valid: %s)", async (valid) => {
		const patch =
			"*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch";
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "gpt-6-astra",
				input: "Create example.txt",
				stream: false,
				tools: [{ type: "custom", name: "apply_patch" }],
			}),
		});
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			async () =>
				new Response(
					JSON.stringify({
						...JSON.parse(ANTHROPIC_MESSAGE_BODY),
						content: [
							{
								type: "tool_use",
								id: "call_patch",
								name: "apply_patch",
								input: valid
									? { input: patch }
									: { unexpected: "invalid input" },
							},
						],
						stop_reason: "tool_use",
					}),
					{ headers: { "content-type": "application/json" } },
				),
			{},
		);
		const body = await response.json();
		if (valid) {
			expect(response.status).toBe(200);
			expect(body.output[0]).toMatchObject({
				type: "custom_tool_call",
				name: "apply_patch",
				call_id: "call_patch",
				input: patch,
			});
		} else {
			expect(response.status).toBe(502);
			expect(body.error.type).toBe("invalid_response_error");
			expect(body.output).toBeUndefined();
		}
	});

	test("translates VS Code additional_tools namespaces without changing native input", async () => {
		const input = [
			{
				type: "additional_tools",
				role: "developer",
				tools: [
					{
						type: "namespace",
						name: "functions",
						tools: [
							{ type: "custom", name: "exec", description: "Execute code" },
						],
					},
				],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Create a file" }],
			},
		];
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-6-astra", input, stream: false }),
		});
		const code =
			'await tools.apply_patch("*** Begin Patch\\n*** Add File: example.txt\\n+hello\\n*** End Patch")';
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			async (upstream) => {
				const body = await upstream.json();
				expect(body.__better_ccflare_codex_passthrough.native_input).toEqual(
					input,
				);
				expect(body.tools).toHaveLength(1);
				expect(body.tools[0].input_schema.properties.input.type).toBe("string");
				return new Response(
					JSON.stringify({
						...JSON.parse(ANTHROPIC_MESSAGE_BODY),
						content: [
							{
								type: "tool_use",
								id: "call_exec",
								name: body.tools[0].name,
								input: { input: code },
							},
						],
						stop_reason: "tool_use",
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
			{},
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.output[0]).toMatchObject({
			type: "custom_tool_call",
			name: "exec",
			namespace: "functions",
			input: code,
		});
	});

	test("Test 4: streaming path → returns a text/event-stream response", async () => {
		const sseBody =
			"event: message_start\ndata: " +
			JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-haiku-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			}) +
			"\n\n" +
			"event: content_block_start\ndata: " +
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}) +
			"\n\n" +
			"event: content_block_delta\ndata: " +
			JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			}) +
			"\n\n" +
			"event: content_block_stop\ndata: " +
			JSON.stringify({
				type: "content_block_stop",
				index: 0,
			}) +
			"\n\n" +
			"event: message_delta\ndata: " +
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			}) +
			"\n\n" +
			"event: message_stop\ndata: " +
			JSON.stringify({ type: "message_stop" }) +
			"\n\n";

		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: true,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(resp.headers.get("content-type")).toContain("text/event-stream");

		// Read body and verify the translation actually ran
		const rawBody = await resp.text();
		expect(rawBody).toContain("response.created");
		expect(rawBody).toContain("response.completed");
	});

	test("streaming custom-tool-call response passes native Responses SSE through unchanged", async () => {
		const diagnosticEvents: Array<{ msg: string; data?: unknown }> = [];
		const onLog = (event: { msg: string; data?: unknown }) => {
			if (event.msg.startsWith("Codex cache")) diagnosticEvents.push(event);
		};
		logBus.on("log", onLog);
		const nativeSseBody =
			"event: response.custom_tool_call\ndata: " +
			JSON.stringify({
				type: "response.custom_tool_call",
				call_id: "call_1",
				name: "shell",
			}) +
			"\n\n" +
			"event: response.completed\ndata: " +
			JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_native",
					model: "gpt-5.6-sol",
					output: [{ type: "output_text", text: "private-output" }],
					prompt_cache_diagnostics: {
						type: "cache_miss",
						reason: "prefix_changed",
						cache_missed_tokens: 2048,
						comparison_reusable_tokens: 1024,
					},
				},
			}) +
			"\n\n";

		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(nativeSseBody, {
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"x-better-ccflare-codex-response-format": "responses-api",
				},
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: true,
			}),
			headers: { "Content-Type": "application/json" },
		});

		try {
			const resp = await handleResponsesRequest(
				req,
				new URL(req.url),
				mockHandleProxy,
				{},
			);

			expect(resp.headers.get("content-type")).toContain("text/event-stream");
			expect(
				resp.headers.get("x-better-ccflare-codex-response-format"),
			).toBeNull();
			const rawBody = await resp.text();
			expect(rawBody).toBe(nativeSseBody);
		} finally {
			logBus.off("log", onLog);
		}

		const responseDiagnostic = diagnosticEvents.find(
			(event) => event.msg === "Codex cache response diagnostics",
		);
		expect(responseDiagnostic?.data).toEqual({
			type: "cache_miss",
			reason: "prefix_changed",
			cacheMissedTokens: 2048,
			comparisonReusableTokens: 1024,
		});
		// Diagnostics are deliberately payload-blind.
		expect(JSON.stringify(diagnosticEvents)).not.toContain("private-output");
		const requestDiagnostic = diagnosticEvents.find(
			(event) => event.msg === "Codex cache request diagnostics",
		);
		expect(requestDiagnostic?.data).toMatchObject({
			transportRequested: "sse",
			previousResponseRequested: false,
			cacheMode: "implicit",
			cacheTtl: "default",
			breakpointCount: 0,
			comparisonResponseIdPresent: false,
		});
		expect(requestDiagnostic?.data).not.toHaveProperty("continuationUsed");
	});

	test("non-streaming custom-tool-call response returns the native Responses JSON instead of a 502", async () => {
		const nativeSseBody =
			"event: response.custom_tool_call\ndata: " +
			JSON.stringify({
				type: "response.custom_tool_call",
				call_id: "call_1",
				name: "shell",
			}) +
			"\n\n" +
			"event: response.completed\ndata: " +
			JSON.stringify({
				type: "response.completed",
				response: { id: "resp_native", model: "gpt-5.6-sol", output: [] },
			}) +
			"\n\n";

		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(nativeSseBody, {
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"x-better-ccflare-codex-response-format": "responses-api",
				},
			});

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: { "Content-Type": "application/json" },
		});

		const resp = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("content-type")).toContain("application/json");
		const body = await resp.json();
		expect(body).toEqual({
			id: "resp_native",
			model: "gpt-5.6-sol",
			output: [],
		});
	});

	test("non-streaming native JSON remains JSON and preserves response attestations", async () => {
		const nativeJson = {
			id: "resp_native_json",
			status: "completed",
			model: "gpt-5.6-sol",
			output: [],
		};
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(JSON.stringify(nativeJson), {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-codex-response-format": "responses-api",
					"x-better-ccflare-transport-used": "http",
					"x-better-ccflare-continuation-used": "false",
					"x-better-ccflare-previous-response-present": "false",
					"x-better-ccflare-stable-prefix-digest": "a".repeat(64),
					"x-better-ccflare-session-digest": "b".repeat(64),
					"x-better-ccflare-continuation-result": "hit",
					"x-better-ccflare-cache-controls-applied": "true",
				},
			});
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: "hello",
				stream: false,
			}),
		});
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(await response.json()).toEqual(nativeJson);
		expect(response.headers.get("x-better-ccflare-transport-used")).toBe(
			"http",
		);
		expect(response.headers.get("x-better-ccflare-stable-prefix-digest")).toBe(
			"a".repeat(64),
		);
		expect(response.headers.get("x-better-ccflare-continuation-result")).toBe(
			"hit",
		);
		expect(
			response.headers.get("x-better-ccflare-cache-controls-applied"),
		).toBe("true");
		expect(
			response.headers.get("x-better-ccflare-codex-response-format"),
		).toBeNull();
	});

	test("normalizes untrusted diagnostic strings instead of logging payload material", async () => {
		const secret = "private-prompt-in-diagnostic-field";
		const events: Array<{ msg: string; data?: unknown }> = [];
		const listener = (event: { msg: string; data?: unknown }) => {
			if (event.msg.startsWith("Codex cache")) events.push(event);
		};
		logBus.on("log", listener);
		try {
			const req = new Request("http://localhost/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-5.6-sol",
					input: "hello",
					prompt_cache_options: { mode: secret, ttl: secret },
				}),
			});
			const response = await handleResponsesRequest(
				req,
				new URL(req.url),
				async () =>
					new Response(
						JSON.stringify({
							id: "resp_diagnostic",
							status: "completed",
							output: [],
							prompt_cache_diagnostics: {
								type: secret,
								reason: secret,
							},
						}),
						{
							status: 200,
							headers: {
								"content-type": "application/json",
								"x-better-ccflare-codex-response-format": "responses-api",
							},
						},
					),
				{},
			);
			await response.text();
		} finally {
			logBus.off("log", listener);
		}
		expect(JSON.stringify(events)).not.toContain(secret);
		const responseDiagnostic = events.find(
			(event) => event.msg === "Codex cache response diagnostics",
		);
		expect(responseDiagnostic?.data).toEqual({
			type: "unknown",
			reason: "unknown",
			cacheMissedTokens: null,
			comparisonReusableTokens: null,
		});
		const requestDiagnostic = events.find(
			(event) => event.msg === "Codex cache request diagnostics",
		);
		expect(requestDiagnostic?.data).toEqual(
			expect.objectContaining({ cacheMode: "invalid", cacheTtl: "invalid" }),
		);
	});

	test("parses CRLF-delimited native SSE for a non-streaming caller", async () => {
		const nativeSse =
			"event: response.completed\r\ndata: " +
			JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_crlf",
					status: "completed",
					model: "gpt-5.6-sol",
					output: [],
				},
			}) +
			"\r\n\r\n";
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(nativeSse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-codex-response-format": "responses-api",
				},
			});
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: "hello",
				stream: false,
			}),
		});
		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(await response.json()).toMatchObject({ id: "resp_crlf" });
	});

	test("joins repeated native SSE data fields for a non-streaming caller", async () => {
		const terminal = JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_multiline",
				status: "completed",
				model: "gpt-5.6-sol",
				output: [],
			},
		});
		const splitAt = terminal.indexOf('"response"');
		const nativeSse = [
			"event: response.completed\n",
			`data: ${terminal.slice(0, splitAt)}\n`,
			`data: ${terminal.slice(splitAt)}\n\n`,
		].join("");
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response(nativeSse, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-better-ccflare-codex-response-format": "responses-api",
				},
			});
		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				input: "hello",
				stream: false,
			}),
		});

		const response = await handleResponsesRequest(
			req,
			new URL(req.url),
			mockHandleProxy,
			{},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: "resp_multiline" });
	});
});
