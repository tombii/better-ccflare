import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAICompatibleProvider } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * End-to-end wiring for the reasoning-field rejection recovery, driven through
 * the real proxy pipeline (`proxyWithAccount` + the real
 * `OpenAICompatibleProvider`).
 *
 * A strict OpenAI-compatible schema rejects the optional effort fields with
 * HTTP 422. This file asserts what actually leaves the proxy on the wire: the
 * first request is retried without the rejected field, and the (account,
 * model) pair is remembered so later requests are pre-stripped instead of
 * spending another failed round trip.
 */

/** Distinctive user text: survives conversion, so "the body was mangled" fails loudly. */
const USER_TEXT_MARKER = "MARKER-reasoning-retry";

/**
 * Unknown to the built-in effort table, so the converter forwards the effort
 * unchanged instead of clamping or dropping it. A Claude model id would not do:
 * Sonnet 4.5 and older deliberately have the field dropped before it is sent.
 */
const CLIENT_MODEL = "grok-4.7-build-fast";
const PRIMARY_MODEL = "grok-4.7-build-primary";
const FALLBACK_MODEL = "grok-4.7-build-fallback";

function makeAccount(
	endpoint: string,
	overrides: Partial<Account> = {},
): Account {
	return {
		id: "acc-strict-reasoning",
		name: "strict-reasoning",
		provider: "openai-compatible",
		api_key: "test-key",
		refresh_token: "test-key",
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
		custom_endpoint: JSON.stringify({ endpoint }),
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

/** Anthropic `/v1/messages` body carrying an internal `reasoning.effort`. */
function makeRequestBody(): ArrayBuffer {
	const body = JSON.stringify({
		model: CLIENT_MODEL,
		max_tokens: 10,
		system: "You are a helpful assistant.",
		messages: [{ role: "user", content: USER_TEXT_MARKER }],
		reasoning: { effort: "high" },
	});
	const bytes = new TextEncoder().encode(body);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-strict-reasoning",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: new OpenAICompatibleProvider(),
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
		forwardToClient: capturingForward,
	};
}

let capturedForward: Response | null = null;

const capturingForward = (async ({ response }: { response: Response }) => {
	capturedForward = response;
	return response;
}) as unknown as NonNullable<ProxyContext["forwardToClient"]>;

async function runProxy(
	account: Account,
	bodyBuffer: ArrayBuffer,
	ctx: ProxyContext,
): Promise<Response | null> {
	return proxyWithAccount(
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		}),
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		bodyBuffer,
		() => undefined,
		0,
		ctx,
	);
}

interface CapturedUpstream {
	url: string;
	headers: Headers;
	bodyText: string;
	bodyJson: Record<string, unknown>;
}

/** The strict-schema rejection Mistral uses for an unknown field. */
const REJECTION_JSON = {
	object: "error",
	message: {
		detail: [
			{
				type: "extra_forbidden",
				loc: ["body", "reasoning_effort"],
				msg: "Extra inputs are not permitted",
			},
		],
	},
};

const CHAT_COMPLETION_JSON = {
	id: "chatcmpl-1",
	object: "chat.completion",
	model: CLIENT_MODEL,
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "hi" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

function installUpstream(options: { rejectFirst?: boolean } = {}): {
	fetchMock: ReturnType<typeof mock>;
	requests: CapturedUpstream[];
} {
	const { rejectFirst = true } = options;
	const requests: CapturedUpstream[] = [];
	const fetchMock = mock(async (input: RequestInfo | URL) => {
		const request =
			input instanceof Request ? input : new Request(String(input));
		const bodyText = await request.clone().text();
		requests.push({
			url: request.url,
			headers: new Headers(request.headers),
			bodyText,
			bodyJson: JSON.parse(bodyText) as Record<string, unknown>,
		});
		// Reject only the first attempt; every retry and every later request
		// succeeds.
		if (rejectFirst && requests.length === 1) {
			return new Response(JSON.stringify(REJECTION_JSON), {
				status: 422,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(CHAT_COMPLETION_JSON), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	return { fetchMock, requests };
}

describe("reasoning-field rejection recovery through proxyWithAccount", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		capturedForward = null;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		capturedForward = null;
	});

	it("retries without reasoning_effort, then pre-strips it for the same account+model", async () => {
		const { fetchMock, requests } = installUpstream();
		const account = makeAccount("https://strict.example.test/v1");

		const first = await runProxy(
			account,
			makeRequestBody(),
			makeProxyContext(),
		);

		// (a) The client saw the successful retry, not the 422.
		expect(first?.status).toBe(200);
		expect(capturedForward?.status).toBe(200);
		expect(fetchMock.mock.calls.length).toBe(2);
		expect(requests).toHaveLength(2);

		const rejected = requests[0] as CapturedUpstream;
		const retried = requests[1] as CapturedUpstream;
		// Non-vacuity guard: the field the upstream rejected was really there.
		expect(rejected.bodyJson.reasoning_effort).toBe("high");
		// (b) The retry no longer carries it.
		expect(retried.bodyJson.reasoning_effort).toBeUndefined();
		expect(retried.bodyText).not.toContain("reasoning_effort");
		// (c) The rest of the body survived the rebuild.
		expect(retried.bodyJson.model).toBe(CLIENT_MODEL);
		expect(retried.bodyJson.max_tokens).toBe(10);
		expect(JSON.stringify(retried.bodyJson)).toContain(USER_TEXT_MARKER);

		// (d) The pair was remembered: a second request is pre-stripped and
		// costs exactly one upstream call, not another reject-then-retry.
		const second = await runProxy(
			account,
			makeRequestBody(),
			makeProxyContext(),
		);

		expect(second?.status).toBe(200);
		expect(fetchMock.mock.calls.length).toBe(3);
		expect(requests).toHaveLength(3);
		const preStripped = requests[2] as CapturedUpstream;
		expect(preStripped.bodyJson.reasoning_effort).toBeUndefined();
		expect(preStripped.bodyText).not.toContain("reasoning_effort");
		expect(JSON.stringify(preStripped.bodyJson)).toContain(USER_TEXT_MARKER);
	});

	it("recovers a rejected effort on a fallback model, then pre-strips that pair", async () => {
		// Primary model is unavailable (404); the configured fallback then
		// rejects the effort field with a 422. The recovery has to run on the
		// fallback response too, or the client gets the 422 it exists to prevent.
		const requests: CapturedUpstream[] = [];
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			const bodyText = await request.clone().text();
			const bodyJson = JSON.parse(bodyText) as Record<string, unknown>;
			requests.push({
				url: request.url,
				headers: new Headers(request.headers),
				bodyText,
				bodyJson,
			});
			const model = bodyJson.model;
			if (model === PRIMARY_MODEL) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "not_found_error", message: "model: not found" },
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			if (bodyJson.reasoning_effort !== undefined) {
				return new Response(JSON.stringify(REJECTION_JSON), {
					status: 422,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify(CHAT_COMPLETION_JSON), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		// The client model is unknown to the built-in table, so the transform
		// forwards its effort unchanged and the fallback really carries the
		// field the upstream rejects. The family mapping is what gives the
		// account a fallback list for it.
		const account = makeAccount("https://strict.example.test/v1", {
			id: "acc-fallback-reasoning",
			model_mappings: JSON.stringify({
				[CLIENT_MODEL]: [PRIMARY_MODEL, FALLBACK_MODEL],
				grok: [PRIMARY_MODEL, FALLBACK_MODEL],
			}),
		});

		const first = await runProxy(
			account,
			makeRequestBody(),
			makeProxyContext(),
		);

		// (a) The client saw the successful recovery retry, not the 422.
		expect(first?.status).toBe(200);
		expect(capturedForward?.status).toBe(200);
		expect(requests).toHaveLength(3);
		const primary = requests[0] as CapturedUpstream;
		const fallbackRejected = requests[1] as CapturedUpstream;
		const fallbackRetried = requests[2] as CapturedUpstream;
		expect(primary.bodyJson.model).toBe(PRIMARY_MODEL);
		expect(fallbackRejected.bodyJson.model).toBe(FALLBACK_MODEL);
		expect(fallbackRejected.bodyJson.reasoning_effort).toBe("high");
		// (b) The recovery retry targets the fallback model without the field.
		expect(fallbackRetried.bodyJson.model).toBe(FALLBACK_MODEL);
		expect(fallbackRetried.bodyJson.reasoning_effort).toBeUndefined();
		expect(fallbackRetried.bodyText).not.toContain("reasoning_effort");
		expect(JSON.stringify(fallbackRetried.bodyJson)).toContain(
			USER_TEXT_MARKER,
		);

		// (c) The (account, fallback model) pair was remembered: a second
		// request costs primary + one pre-stripped fallback call.
		const second = await runProxy(
			account,
			makeRequestBody(),
			makeProxyContext(),
		);
		expect(second?.status).toBe(200);
		expect(requests).toHaveLength(5);
		expect((requests[3] as CapturedUpstream).bodyJson.model).toBe(
			PRIMARY_MODEL,
		);
		const preStripped = requests[4] as CapturedUpstream;
		expect(preStripped.bodyJson.model).toBe(FALLBACK_MODEL);
		expect(preStripped.bodyJson.reasoning_effort).toBeUndefined();
		expect(preStripped.bodyText).not.toContain("reasoning_effort");
	});

	it("keeps the rejected response readable when the retry send throws", async () => {
		const requests: CapturedUpstream[] = [];
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			const bodyText = await request.clone().text();
			requests.push({
				url: request.url,
				headers: new Headers(request.headers),
				bodyText,
				bodyJson: JSON.parse(bodyText) as Record<string, unknown>,
			});
			if (requests.length === 1) {
				return new Response(JSON.stringify(REJECTION_JSON), {
					status: 422,
					headers: { "content-type": "application/json" },
				});
			}
			throw new TypeError("fetch failed: socket hang up");
		});
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		const account = makeAccount("https://strict.example.test/v1", {
			id: "acc-throwing-retry",
		});

		const result = await runProxy(
			account,
			makeRequestBody(),
			makeProxyContext(),
		);

		// The retry was attempted and failed...
		expect(requests).toHaveLength(2);
		// ...but the client still gets the upstream's original 422, with its
		// body intact, rather than a drained response or a 500.
		expect(result?.status).toBe(422);
		expect(capturedForward?.status).toBe(422);
		const body = await result?.text();
		expect(body).toContain("reasoning_effort");
		expect(body).toContain("Extra inputs are not permitted");
	});

	it("does not touch the field for an upstream that accepts it", async () => {
		// Control: without a rejection, the effort reaches the upstream, proving
		// the assertions above are the recovery's doing and not the converter
		// dropping the field.
		const { fetchMock, requests } = installUpstream({ rejectFirst: false });
		const account = makeAccount("https://strict.example.test/v1", {
			id: "acc-strict-reasoning-control",
		});

		const result = await runProxy(
			account,
			makeRequestBody(),
			makeProxyContext(),
		);

		expect(result?.status).toBe(200);
		expect(fetchMock.mock.calls.length).toBe(1);
		const sent = requests[0] as CapturedUpstream;
		expect(sent.bodyJson.reasoning_effort).toBe("high");
	});
});
