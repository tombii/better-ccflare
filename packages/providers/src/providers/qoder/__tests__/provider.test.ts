import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { encodeQoderAccessToken } from "../auth-flow";
import { decodeQoderBody } from "../cosy";
import { parseBusyError, peekQoderStream, QoderProvider } from "../provider";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "qoder-1",
		name: "qoder-test",
		provider: "qoder",
		api_key: null,
		refresh_token: "pt-personal-token",
		access_token: encodeQoderAccessToken("pat", "jt-access"),
		expires_at: Date.now() + 3_600_000,
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
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		request_transformer: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

interface Captured {
	url: string;
	init: RequestInit | undefined;
}

let calls: Captured[] = [];
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Route fetch by URL: userinfo answers, everything else gets `respond`. */
function route(respond: (call: Captured) => Response) {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init };
		calls.push(call);
		if (call.url.endsWith("/api/v1/userinfo")) {
			return jsonResponse({ id: "uid-42", email: "a@b.c", name: "Tester" });
		}
		return respond(call);
	}) as unknown as typeof fetch;
}

function sseResponse(frames: string[]): Response {
	return new Response(frames.join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream;charset=UTF-8" },
	});
}

function frame(chunk: unknown): string {
	return `data: ${JSON.stringify({ body: JSON.stringify(chunk), statusCodeValue: 200 })}\n\n`;
}

function anthropicRequest(
	body: Record<string, unknown> = {},
	headers: Record<string, string> = {},
	_accessToken?: string,
): Request {
	return new Request("https://better-ccflare.local/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer client-key",
			"x-api-key": "client-key",
			"anthropic-version": "2023-06-01",
			"x-better-ccflare-account-id": "qoder-1",
			...headers,
		},
		body: JSON.stringify({
			model: "qfmodel",
			max_tokens: 100,
			messages: [{ role: "user", content: "hello" }],
			...body,
		}),
	});
}

/** Resolve with a marker if the promise does not settle in time. */
async function withWatchdog<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | "TIMEOUT"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"TIMEOUT">((resolve) => {
		timer = setTimeout(() => resolve("TIMEOUT"), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function _headersOf(call: Captured): Headers {
	return new Headers(call.init?.headers);
}

beforeEach(() => {
	calls = [];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("QoderProvider identity", () => {
	const provider = new QoderProvider();

	it("is named qoder", () => {
		expect(provider.name).toBe("qoder");
	});

	it("handles the messages, count_tokens and models paths only", () => {
		expect(provider.canHandle("/v1/messages")).toBe(true);
		expect(provider.canHandle("/v1/messages/count_tokens")).toBe(true);
		expect(provider.canHandle("/v1/models")).toBe(true);
		expect(provider.canHandle("/v1/complete")).toBe(false);
		expect(provider.canHandle("/health")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

describe("buildUrl", () => {
	const provider = new QoderProvider();
	const GATEWAY =
		"https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

	it("sends /v1/messages to the gateway chat route with its fixed query", () => {
		expect(provider.buildUrl("/v1/messages", "", makeAccount())).toBe(GATEWAY);
	});

	it("ignores the client's query string on /v1/messages", () => {
		expect(provider.buildUrl("/v1/messages", "?beta=true", makeAccount())).toBe(
			GATEWAY,
		);
	});

	it("routes /v1/models to the COSY model list", () => {
		expect(provider.buildUrl("/v1/models", "", makeAccount())).toBe(
			"https://api3.qoder.sh/algo/api/v2/model/list",
		);
	});

	it("uses the CN gateway from a custom endpoint", () => {
		const account = makeAccount({
			custom_endpoint: JSON.stringify({
				endpoint: "https://gateway.qoder.com.cn",
			}),
		});
		expect(
			provider
				.buildUrl("/v1/messages", "", account)
				.startsWith(
					"https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?",
				),
		).toBe(true);
	});

	it("accepts a custom endpoint that is JSON with an endpoint member", () => {
		const account = makeAccount({
			custom_endpoint: JSON.stringify({
				endpoint: "https://gateway.example.com/",
				modelMappings: { sonnet: "dfmodel" },
			}),
		});
		expect(provider.buildUrl("/v1/models", "", account)).toBe(
			"https://gateway.example.com/algo/api/v2/model/list",
		);
	});
});

// ---------------------------------------------------------------------------
// prepareHeaders
// ---------------------------------------------------------------------------

describe("prepareHeaders", () => {
	const provider = new QoderProvider();

	const CLIENT_HEADERS = {
		authorization: "Bearer client-key",
		"x-api-key": "client-key",
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "oauth-2025",
		cookie: "session=abc",
		host: "better-ccflare.local",
		"x-forwarded-for": "1.2.3.4",
		"cf-connecting-ip": "1.2.3.4",
		"x-request-id": "client-rid",
	};

	it("strips every client credential, identity and CDN header", () => {
		const headers = provider.prepareHeaders(
			new Headers(CLIENT_HEADERS),
			encodeQoderAccessToken("pat", "jt-access"),
			undefined,
		);
		for (const gone of Object.keys(CLIENT_HEADERS)) {
			expect(headers.get(gone)).toBeNull();
		}
	});

	it("never emits a COSY envelope here: the signature needs the body", () => {
		const headers = provider.prepareHeaders(
			new Headers(CLIENT_HEADERS),
			encodeQoderAccessToken("pat", "jt-access"),
			undefined,
		);
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("cosy-date")).toBeNull();
	});

	it("never forwards a client credential, even in passthrough mode", () => {
		// Qoder has no passthrough form: every upstream request is COSY-signed.
		const headers = provider.prepareHeaders(
			new Headers({ authorization: "Bearer client-key", "x-api-key": "k" }),
			undefined,
			undefined,
		);
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-api-key")).toBeNull();
	});
});

describe("transformRequestBody (continued)", () => {
	const provider = new QoderProvider();
	const ACCOUNT = makeAccount();

	async function transformed(request: Request, account = ACCOUNT) {
		const out = await provider.transformRequestBody(request, account);
		const encoded = await out.text();
		return { out, encoded };
	}

	it("remembers the model key for the response transform", async () => {
		route(() => jsonResponse({}));
		const req = anthropicRequest({ model: "dfmodel" });
		const out = await provider.transformRequestBody(req, ACCOUNT);
		expect(provider.modelKeyFor(out)).toBe("dfmodel");
	});

	it("records the client's stream intent on the request", async () => {
		route(() => jsonResponse({}));
		const streaming = await transformed(anthropicRequest({ stream: true }));
		expect(streaming.out.headers.get("x-better-ccflare-request-stream")).toBe(
			"true",
		);
		calls = [];
		const buffered = await transformed(
			anthropicRequest(),
			makeAccount({ id: "qoder-2" }),
		);
		expect(buffered.out.headers.get("x-better-ccflare-request-stream")).toBe(
			"false",
		);
	});

	it("rejects a body with no model at all", async () => {
		route(() => jsonResponse({}));
		await expect(transformed(anthropicRequest({ model: "" }))).rejects.toThrow(
			/model/i,
		);
	});

	it("passes a non-JSON request through untouched", async () => {
		route(() => jsonResponse({}));
		const req = new Request("https://better-ccflare.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "hi",
		});
		const out = await provider.transformRequestBody(req, ACCOUNT);
		expect(out).toBe(req);
	});

	it("re-signs an already encoded body on a proxy retry, without re-encoding", async () => {
		route(() => jsonResponse({}));
		const first = await provider.transformRequestBody(
			anthropicRequest({ model: "qfmodel" }),
			ACCOUNT,
		);
		const encoded = await first.text();
		const replay = new Request(first.url, {
			method: "POST",
			headers: first.headers,
			body: encoded,
		});
		const again = await provider.transformRequestBody(replay, ACCOUNT);
		expect(await again.text()).toBe(encoded);
		// A signature is one-shot; the replay carries a fresh one.
		expect(again.headers.get("authorization")).not.toBe(
			first.headers.get("authorization"),
		);
		expect(again.headers.get("cosy-user")).toBe("uid-42");
	});

	it("answers the rewritten count_tokens request with a synthetic response", async () => {
		route(() => jsonResponse({}));
		calls = [];
		// After buildUrl(), the proxy sees the chat route with the client's
		// count_tokens body; the provider must not ship that upstream.
		const request = new Request(
			provider.buildUrl("/v1/messages/count_tokens", "", ACCOUNT),
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "qfmodel",
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);
		const out = await provider.transformRequestBody(request, ACCOUNT);
		expect(out.headers.get("x-better-ccflare-synthetic-response")).toBe("true");
		expect(out.url.startsWith("https://better-ccflare.local/")).toBe(true);
		const body = (await out.json()) as { input_tokens?: number };
		expect(typeof body.input_tokens).toBe("number");
		// An estimate, not a zero: Qoder has no count endpoint, and a client
		// budgeting against zero would mis-plan every request.
		expect(body.input_tokens).toBeGreaterThan(0);
		expect(calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// processResponse
// ---------------------------------------------------------------------------

describe("processResponse", () => {
	const provider = new QoderProvider();
	const ACCOUNT = makeAccount();

	const OPENAI_LIKE = [
		frame({ model: "auto", choices: [{ delta: { content: "ok" } }] }),
		frame({
			model: "auto",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
	];

	/** The upstream echoes what the proxy tagged the response with. */
	function tagged(response: Response, model = "qfmodel"): Response {
		const headers = new Headers(response.headers);
		headers.set("x-better-ccflare-qoder-model", model);
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	}

	function tagRequestPath(response: Response, path: string): Response {
		const headers = new Headers(response.headers);
		headers.set("x-better-ccflare-request-path", path);
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	}

	it("streams Anthropic SSE for a streaming client", async () => {
		const response = tagged(
			tagRequestPath(sseResponse(OPENAI_LIKE), "/v1/messages"),
		);
		const out = await provider.processResponse(response, ACCOUNT);
		const text = await out.text();
		expect(text).toContain('"type":"message_start"');
		expect(text).toContain('"text":"ok"');
		expect(out.headers.get("content-type")).toContain("text/event-stream");
	});

	it("aggregates into an Anthropic JSON message for a non-streaming client", async () => {
		const response = tagged(
			tagRequestPath(sseResponse(OPENAI_LIKE), "/v1/messages"),
		);
		const headers = new Headers({ "x-better-ccflare-request-stream": "false" });
		const out = await provider.processResponse(
			response,
			ACCOUNT,
			headers,
			undefined,
			{ requestModel: "qfmodel" },
		);
		expect(out.headers.get("content-type")).toBe("application/json");
		const body = (await out.json()) as {
			type: string;
			model: string;
			content: Array<{ type: string; text?: string }>;
		};
		expect(body.type).toBe("message");
		expect(body.model).toBe("qfmodel");
		expect(body.content).toContainEqual({ type: "text", text: "ok" });
	});

	it("reports a non-streaming in-band failure with a real HTTP status", async () => {
		const response = tagged(
			tagRequestPath(
				sseResponse([frame({ code: 116, error: "quota exceeded" })]),
				"/v1/messages",
			),
		);
		const headers = new Headers({ "x-better-ccflare-request-stream": "false" });
		const out = await provider.processResponse(
			response,
			ACCOUNT,
			headers,
			undefined,
			{ requestModel: "qfmodel" },
		);
		expect(out.status).toBe(429);
		const body = (await out.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.message).toContain("quota");
	});

	it("maps a busy code to 503 for a non-streaming client", async () => {
		const response = tagged(
			tagRequestPath(
				sseResponse([frame({ code: 10605, error: "busy" })]),
				"/v1/messages",
			),
		);
		const out = await provider.processResponse(
			response,
			ACCOUNT,
			new Headers({ "x-better-ccflare-request-stream": "false" }),
			undefined,
			{ requestModel: "qfmodel" },
		);
		expect(out.status).toBe(503);
	});

	it("passes a non-OK, non-SSE response through", async () => {
		const upstream = new Response('{"error":"nope"}', {
			status: 500,
			headers: { "content-type": "application/json" },
		});
		const out = await provider.processResponse(
			tagRequestPath(upstream, "/v1/messages"),
			ACCOUNT,
		);
		expect(out.status).toBe(500);
		expect(await out.text()).toBe('{"error":"nope"}');
	});

	it("translates the model list into an Anthropic models response", async () => {
		const upstream = jsonResponse({
			chat: [
				{
					key: "qfmodel",
					display_name: "Qwen3.8-Flash",
					enable: true,
					price_factor: 0,
				},
				{
					key: "gmodel",
					display_name: "GLM-5.3",
					enable: false,
					price_factor: 0.8,
				},
			],
		});
		const out = await provider.processResponse(
			tagRequestPath(upstream, "/v1/models"),
			ACCOUNT,
		);
		const body = (await out.json()) as {
			data: Array<{ id: string; display_name: string }>;
		};
		expect(body.data.map((m) => m.id)).toEqual(["qfmodel"]);
		expect(body.data[0].display_name).toBe("Qwen3.8-Flash");
	});
});

// ---------------------------------------------------------------------------
// parseRateLimit
// ---------------------------------------------------------------------------

describe("parseRateLimit", () => {
	const provider = new QoderProvider();

	it("is not rate limited on a success", () => {
		expect(provider.parseRateLimit(new Response("", { status: 200 }))).toEqual({
			isRateLimited: false,
		});
	});

	it("reports a 429 with its retry-after", () => {
		const info = provider.parseRateLimit(
			new Response("", { status: 429, headers: { "retry-after": "60" } }),
		);
		expect(info.isRateLimited).toBe(true);
		expect(info.resetTime).toBeGreaterThan(Date.now() + 50_000);
		expect(info.resetTime).toBeLessThan(Date.now() + 70_000);
	});

	it("does not emit a statusHeader snapshot it cannot know", () => {
		const info = provider.parseRateLimit(new Response("", { status: 429 }));
		expect(info.statusHeader).toBeUndefined();
	});

	/**
	 * Qoder's gateway answers a saturated model with an error frame and then
	 * holds the SSE connection open indefinitely. A provider that waits for
	 * the body to end wedges the request forever; the peek must decide on the
	 * frame and release the connection.
	 */
	it("answers a busy stream without waiting for the connection to close", async () => {
		const provider = new QoderProvider();
		const inner = JSON.stringify({
			isQueued: true,
			retryAfterSeconds: 3,
			subCode: "RESOURCE_LIMIT",
		});
		const middle = JSON.stringify({ code: "10605", message: inner });
		const frameEnvelope = {
			body: JSON.stringify({ code: "403", message: middle }),
			statusCodeValue: 403,
			statusCode: "FORBIDDEN",
			headers: { "Retry-After": ["3"] },
		};
		// The frame arrives, and then the socket stays open: `close()` is never
		// called, exactly as the gateway does.
		let closed = false;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data:${JSON.stringify({ body: JSON.stringify(frameEnvelope), statusCodeValue: 200 })}\n\n`,
					),
				);
			},
			pull() {
				// Deliberately never enqueues and never closes.
			},
			cancel() {
				closed = true;
			},
		});
		const response = new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const out = await withWatchdog(
			provider.processResponse(response, makeAccount()),
			2000,
		);
		expect(out).not.toBe("TIMEOUT");
		const result = out as Response;
		expect(result.status).toBe(503);
		expect(result.headers.get("retry-after")).toBe("3");
		const payload = (await result.json()) as { error: { type: string } };
		expect(payload.error.type).toBe("overloaded_error");
		expect(closed).toBe(true);
	});

	it("relabels the gateway's busy 403 as 503 + Retry-After", async () => {
		const provider = new QoderProvider();
		const inner = JSON.stringify({
			isQueued: true,
			retryAfterSeconds: 3,
			subCode: "RESOURCE_LIMIT",
		});
		// Captured live: HTTP 200, an outer 200 SSE frame, then the gateway's
		// 403 frame whose `message` is itself JSON, then a third JSON layer.
		const middle = JSON.stringify({ code: "10605", message: inner });
		// The gateway answers HTTP 200 with an SSE-framed 403 envelope; the
		// relabelling happens on that frame, not on an HTTP status.
		const frameEnvelope = {
			body: JSON.stringify({ code: "403", message: middle }),
			statusCodeValue: 403,
			statusCode: "FORBIDDEN",
			headers: { "Retry-After": ["3"] },
		};
		const response = new Response(
			`data:${JSON.stringify({ body: JSON.stringify(frameEnvelope), statusCodeValue: 200 })}`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
		const out = await provider.processResponse(
			response,
			makeAccount(),
			new Headers({ "x-better-ccflare-request-stream": "false" }),
		);
		expect(out.status).toBe(503);
		expect(out.headers.get("retry-after")).toBe("3");
		const body = (await out.json()) as { error: { type: string } };
		expect(body.error.type).toBe("overloaded_error");
	});

	it("relabels a bare-JSON busy answer as 503 + Retry-After", async () => {
		const provider = new QoderProvider();
		const inner = JSON.stringify({
			isQueued: true,
			retryAfterSeconds: 3,
			serviceAvailable: false,
		});
		const middle = JSON.stringify({ code: "10605", message: inner });
		const response = new Response(
			JSON.stringify({ code: "403", message: middle }),
			{
				status: 403,
				headers: { "content-type": "application/json" },
			},
		);
		const out = await provider.processResponse(response, makeAccount());
		expect(out.status).toBe(503);
		expect(out.headers.get("retry-after")).toBe("3");
		const body = (await out.json()) as { error: { type: string } };
		expect(body.error.type).toBe("overloaded_error");
	});

	it("passes an ordinary JSON error through with its status", async () => {
		const provider = new QoderProvider();
		const response = new Response(JSON.stringify({ code: 116 }), {
			status: 402,
			headers: { "content-type": "application/json" },
		});
		const out = await provider.processResponse(response, makeAccount());
		expect(out.status).toBe(402);
		expect(await out.json()).toEqual({ code: 116 });
	});
});

// ---------------------------------------------------------------------------
// refreshToken / model defaults
// ---------------------------------------------------------------------------

describe("configuration", () => {
	it("claims OAuth-style credential renewal (PAT-backed)", () => {
		expect(new QoderProvider().supportsOAuth()).toBe(true);
	});

	it("enables usage tracking", () => {
		expect(new QoderProvider().supportsUsageTracking()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe("model resolution", () => {
	const provider = new QoderProvider();

	/** The wire key the provider actually put in the encoded body. */
	async function wireKey(request: Request, account: Account): Promise<string> {
		route(() => jsonResponse({}));
		const out = await provider.transformRequestBody(request, account);
		const body = JSON.parse(decodeQoderBody(await out.text())) as {
			model_config: { key: string };
		};
		return body.model_config.key;
	}

	it("maps a Claude family onto the provider's default wire key", async () => {
		const account = makeAccount();
		expect(
			await wireKey(anthropicRequest({ model: "claude-sonnet-4-5" }), account),
		).toBe("dfmodel");
		expect(
			await wireKey(anthropicRequest({ model: "claude-opus-4-1" }), account),
		).toBe("qfmodel");
	});

	it("prefers the account's own model mappings", async () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ sonnet: "gmodel" }),
		});
		expect(
			await wireKey(anthropicRequest({ model: "claude-sonnet-4-5" }), account),
		).toBe("gmodel");
	});

	it("uses a Qoder wire key verbatim", async () => {
		const account = makeAccount();
		expect(await wireKey(anthropicRequest({ model: "qfmodel" }), account)).toBe(
			"qfmodel",
		);
	});

	it("throws a clear error naming the model when nothing resolves", async () => {
		route(() => jsonResponse({}));
		await expect(
			provider.transformRequestBody(
				anthropicRequest({ model: "" }),
				makeAccount(),
			),
		).rejects.toThrow(/model/i);
	});

	it("tags the request with the resolved key", async () => {
		route(() => jsonResponse({}));
		const out = await provider.transformRequestBody(
			anthropicRequest({ model: "claude-sonnet-4-5" }),
			makeAccount(),
		);
		expect(out.headers.get("x-better-ccflare-qoder-model")).toBe("dfmodel");
		expect(out.headers.get("x-model-key")).toBe("dfmodel");
		expect(out.headers.get("x-model-source")).toBe("system");
	});

	it("uses ONE uuid for the body, the COSY payload and the X-Request-Id", async () => {
		route(() => jsonResponse({}));
		const out = await provider.transformRequestBody(
			anthropicRequest({ model: "qfmodel" }),
			makeAccount(),
		);
		const body = JSON.parse(decodeQoderBody(await out.text())) as {
			request_id: string;
		};
		const headerId = out.headers.get("x-request-id");
		const authorization = out.headers.get("authorization") ?? "";
		const payload = JSON.parse(
			Buffer.from(
				authorization.replace("Bearer COSY.", "").split(".")[0],
				"base64",
			).toString("utf8"),
		) as { requestId: string };
		expect(body.request_id).toBe(headerId);
		expect(payload.requestId).toBe(headerId);
	});
});

// ---------------------------------------------------------------------------
// Response attribution
// ---------------------------------------------------------------------------

describe("response attribution", () => {
	const provider = new QoderProvider();

	const OPENAI_LIKE = [
		frame({ model: "auto", choices: [{ delta: { content: "ok" } }] }),
		frame({
			model: "auto",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
	];

	function tagRequestPath(response: Response, path: string): Response {
		const headers = new Headers(response.headers);
		headers.set("x-better-ccflare-request-path", path);
		return new Response(response.body, { status: response.status, headers });
	}

	it("falls back to the last key sent for the account when the tag is missing", async () => {
		route(() => jsonResponse({}));
		const account = makeAccount();
		await provider.transformRequestBody(
			anthropicRequest({ model: "claude-sonnet-4-5" }),
			account,
		);
		// No tag on the response, and the proxy's own model is empty for Qoder
		// (the transformed body is an encoded wire string).
		const out = await provider.processResponse(
			tagRequestPath(sseResponse(OPENAI_LIKE), "/v1/messages"),
			account,
			new Headers({ "x-better-ccflare-request-stream": "false" }),
			undefined,
			{ requestModel: "" },
		);
		const body = (await out.json()) as { model: string };
		expect(body.model).toBe("dfmodel");
	});

	it("falls back to 'unknown' when nothing was ever sent", async () => {
		const out = await provider.processResponse(
			tagRequestPath(sseResponse(OPENAI_LIKE), "/v1/messages"),
			makeAccount({ id: "qoder-unknown" }),
			new Headers({ "x-better-ccflare-request-stream": "false" }),
			undefined,
			{ requestModel: "" },
		);
		const body = (await out.json()) as { model: string };
		expect(body.model).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// Busy answers
// ---------------------------------------------------------------------------

describe("parseBusyError", () => {
	it("reads the SSE envelope shape", () => {
		const inner = JSON.stringify({
			isQueued: true,
			retryAfterSeconds: 3,
			serviceAvailable: false,
		});
		const middle = JSON.stringify({ code: "10605", message: inner });
		const envelope = JSON.stringify({
			body: JSON.stringify({ code: "403", message: middle }),
			statusCodeValue: 403,
		});
		expect(parseBusyError(`data:${envelope}`)).toEqual({
			retryAfterSeconds: 3,
		});
	});

	it("reads a bare JSON body", () => {
		const inner = JSON.stringify({
			isQueued: true,
			retryAfterSeconds: 7,
			serviceAvailable: false,
		});
		const middle = JSON.stringify({ code: "10605", message: inner });
		const body = JSON.stringify({ code: "403", message: middle });
		expect(parseBusyError(body)).toEqual({ retryAfterSeconds: 7 });
	});

	it("reads a flat bare busy body", () => {
		expect(parseBusyError(JSON.stringify({ code: 10605 }))).toEqual({
			retryAfterSeconds: 30,
		});
	});

	it("leaves an ordinary error alone", () => {
		expect(
			parseBusyError(JSON.stringify({ code: 116, error: "quota" })),
		).toBeNull();
		expect(parseBusyError("not json at all")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Streaming failures
// ---------------------------------------------------------------------------

describe("mid-stream failures", () => {
	it("cancels the upstream reader when the stream fails mid-response", async () => {
		const provider = new QoderProvider();
		let cancelled = false;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						frame({
							model: "auto",
							choices: [{ delta: { content: "partial" } }],
						}),
					),
				);
				controller.enqueue(
					encoder.encode(frame({ code: 116, error: "quota exceeded" })),
				);
				// The gateway holds the connection open: it never closes.
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const out = await provider.processResponse(response, makeAccount());
		const text = await out.text();
		expect(text).toContain("partial");
		expect(cancelled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The outcome peek
// ---------------------------------------------------------------------------

describe("peekQoderStream", () => {
	it("gives up on a stream that only sends keep-alives", async () => {
		// The deadline is for the WHOLE peek, not for each read: a stream that
		// keeps sending keep-alive comments would otherwise keep the peek alive
		// forever, one short read at a time.
		let cancelled = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				timer = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": keepalive\n\n"));
					} catch {
						// The stream was cancelled: nothing left to feed.
					}
				}, 5);
			},
			cancel() {
				cancelled = true;
				if (timer) clearInterval(timer);
			},
		});
		const peek = await peekQoderStream(body, 100);
		expect(peek.error?.status).toBe(504);
		expect(cancelled).toBe(true);
	});
});
