import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	BETTER_CCFLARE_REQUEST_SOURCE_HEADER,
	CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV,
	CODEX_CLAUDE_OAUTH_ALLOWLIST_HEADER,
	CODEX_CLAUDE_OAUTH_MODE_COMPAT,
	CODEX_CLAUDE_OAUTH_MODE_ENV,
	CODEX_CLAUDE_OAUTH_MODE_HEADER,
	CODEX_CLAUDE_OAUTH_MODE_SAFE,
	CODEX_RESPONSES_REQUEST_SOURCE,
} from "@better-ccflare/types";
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
	const savedEnv = {
		mode: process.env[CODEX_CLAUDE_OAUTH_MODE_ENV],
		allowlist: process.env[CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV],
	};

	beforeEach(() => {
		delete process.env[CODEX_CLAUDE_OAUTH_MODE_ENV];
		delete process.env[CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV];
	});

	afterEach(() => {
		if (savedEnv.mode === undefined)
			delete process.env[CODEX_CLAUDE_OAUTH_MODE_ENV];
		else process.env[CODEX_CLAUDE_OAUTH_MODE_ENV] = savedEnv.mode;
		if (savedEnv.allowlist === undefined)
			delete process.env[CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV];
		else
			process.env[CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV] =
				savedEnv.allowlist;
	});

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

	test("excludes Anthropic OAuth from /v1/responses by default", async () => {
		let capturedHeaders: Headers | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2) => {
			capturedHeaders = req2.headers;
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

		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});

		expect(capturedHeaders?.get("x-better-ccflare-exclude-providers")).toBe(
			"anthropic-oauth",
		);
		expect(capturedHeaders?.get(CODEX_CLAUDE_OAUTH_MODE_HEADER)).toBe(
			CODEX_CLAUDE_OAUTH_MODE_SAFE,
		);
		expect(
			capturedHeaders?.get(CODEX_CLAUDE_OAUTH_ALLOWLIST_HEADER),
		).toBeNull();
		expect(capturedHeaders?.get(BETTER_CCFLARE_REQUEST_SOURCE_HEADER)).toBe(
			CODEX_RESPONSES_REQUEST_SOURCE,
		);
	});

	test("claude-code-compat mode allows only the configured Anthropic OAuth allowlist", async () => {
		process.env[CODEX_CLAUDE_OAUTH_MODE_ENV] = CODEX_CLAUDE_OAUTH_MODE_COMPAT;
		process.env[CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV] =
			" Jenny_claude, 9febdbc2-a6ab-4ef6-b34d-7fd1db31a9d1 ";

		let capturedHeaders: Headers | null = null;
		let capturedUrl: URL | null = null;
		let capturedBody: Record<string, unknown> | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2, url2) => {
			capturedHeaders = req2.headers;
			capturedUrl = url2;
			capturedBody = (await req2.json()) as Record<string, unknown>;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-haiku-4-5",
				instructions: "Original Codex instructions",
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

		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});

		expect(
			capturedHeaders?.get("x-better-ccflare-exclude-providers"),
		).toBeNull();
		expect(capturedHeaders?.get(CODEX_CLAUDE_OAUTH_MODE_HEADER)).toBe(
			CODEX_CLAUDE_OAUTH_MODE_COMPAT,
		);
		expect(capturedHeaders?.get(CODEX_CLAUDE_OAUTH_ALLOWLIST_HEADER)).toBe(
			"Jenny_claude,9febdbc2-a6ab-4ef6-b34d-7fd1db31a9d1",
		);
		expect(capturedUrl?.searchParams.get("beta")).toBe("true");
		expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01");
		expect(capturedHeaders?.get("anthropic-beta")).toContain(
			"claude-code-20250219",
		);
		expect(capturedHeaders?.get("anthropic-beta")).toContain(
			"oauth-2025-04-20",
		);
		expect(capturedHeaders?.get("anthropic-beta")).toContain(
			"interleaved-thinking-2025-05-14",
		);
		expect(capturedHeaders?.get("anthropic-beta")).toContain(
			"prompt-caching-scope-2026-01-05",
		);
		expect(capturedHeaders?.get("anthropic-beta")).toContain(
			"token-efficient-tools-2026-03-28",
		);
		expect(capturedHeaders?.get("x-app")).toBe("cli");
		expect(capturedHeaders?.get("user-agent")).toBe("@anthropic-ai/sdk/0.74.0");
		expect(capturedHeaders?.get("x-stainless-package-version")).toBe("0.74.0");
		expect(capturedHeaders?.get("x-stainless-runtime")).toBe("node");
		expect(capturedHeaders?.get("x-client-request-id")).toMatch(
			/^[0-9a-f-]{36}$/,
		);
		expect(capturedHeaders?.get("x-claude-code-session-id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const system = capturedBody?.system as Array<{ text: string }> | undefined;
		expect(system?.[0]?.text).toContain("x-anthropic-billing-header:");
		expect(system?.[1]?.text).toBe(
			"You are Claude Code, Anthropic's official CLI for Claude.",
		);
		expect(system?.[2]?.text).toContain("You help with code changes");
		const messages = capturedBody?.messages as Array<{
			role: string;
			content: Array<{ type: string; text?: string }>;
		}>;
		expect(messages[0]?.content[0]?.text).toBe("Original Codex instructions");
	});

	test("claude-code-compat mode without an allowlist stays safe", async () => {
		process.env[CODEX_CLAUDE_OAUTH_MODE_ENV] = CODEX_CLAUDE_OAUTH_MODE_COMPAT;

		let capturedHeaders: Headers | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2) => {
			capturedHeaders = req2.headers;
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

		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});

		expect(capturedHeaders?.get("x-better-ccflare-exclude-providers")).toBe(
			"anthropic-oauth",
		);
		expect(capturedHeaders?.get(CODEX_CLAUDE_OAUTH_MODE_HEADER)).toBe(
			CODEX_CLAUDE_OAUTH_MODE_SAFE,
		);
		expect(
			capturedHeaders?.get(CODEX_CLAUDE_OAUTH_ALLOWLIST_HEADER),
		).toBeNull();
	});

	test("strips client-forged internal probe headers from responses traffic", async () => {
		process.env[CODEX_CLAUDE_OAUTH_MODE_ENV] = CODEX_CLAUDE_OAUTH_MODE_COMPAT;
		process.env[CODEX_CLAUDE_OAUTH_ACCOUNT_ALLOWLIST_ENV] = "Jenny_claude";

		let capturedHeaders: Headers | null = null;
		const mockHandleProxy: HandleProxyFn = async (req2) => {
			capturedHeaders = req2.headers;
			return new Response(ANTHROPIC_MESSAGE_BODY, {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const req = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "claude-fable-5",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi" }],
					},
				],
				stream: false,
			}),
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-account-id": "acc-jenny",
				"x-better-ccflare-auto-refresh": "true",
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-keepalive": "true",
			},
		});

		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});

		expect(capturedHeaders?.get("x-better-ccflare-bypass-session")).toBeNull();
		expect(capturedHeaders?.get("x-better-ccflare-auto-refresh")).toBeNull();
		expect(capturedHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		expect(capturedHeaders?.get("x-better-ccflare-account-id")).toBe(
			"acc-jenny",
		);
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
		await handleResponsesRequest(req, new URL(req.url), mockHandleProxy, {});
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

	test("Test 3: error passthrough → if handleProxy returns 429, handler returns 429", async () => {
		const mockHandleProxy: HandleProxyFn = async () =>
			new Response("rate limited", { status: 429 });

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
});
