import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	deriveMistralAffinityId,
	MISTRAL_AFFINITY_HEADER,
	OpenAICompatibleProvider,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * End-to-end wiring for the Mistral cache rules, driven through the real proxy
 * pipeline (`proxyWithAccount` + the real `OpenAICompatibleProvider`), not the
 * provider helpers in isolation.
 *
 * Why this file exists: `packages/providers/.../mistral.test.ts` exercises
 * `applyMistralAffinityHeader` and `stripMistralReasoning` directly, so it
 * stays green even if `proxy-operations.ts` never calls the header helper or
 * never pre-strips `cache_control` for a Mistral endpoint. These cases assert
 * what actually leaves the proxy on the wire.
 *
 * The control case is what makes the Mistral assertions non-vacuous: the same
 * Anthropic request body, sent to a non-Mistral endpoint, must still carry
 * `cache_control` downstream. That proves the Anthropic→OpenAI conversion
 * preserves the markers, so their absence on the Mistral cases is the
 * pre-strip doing its job rather than the markers never existing.
 */

const SESSION_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

/** Distinctive user text: survives conversion, so "the body was mangled" fails loudly. */
const USER_TEXT_MARKER = "MARKER-mistral-cache-prefix";

function makeAccount(
	endpoint: string,
	overrides: Partial<Account> = {},
): Account {
	return {
		id: "acc-mistral-cache",
		name: "mistral-cache",
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
		// A Mistral endpoint is configured exactly like this: a JSON envelope
		// around the base URL (see mistral-reasoning.test.ts fixtures).
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

/**
 * Anthropic `/v1/messages` body with `cache_control` on both a system block and
 * a user content block. The conversion emits array content for both, which is
 * the shape `stripCacheControlFromOpenAIRequest` deletes from.
 */
function makeRequestBody(): ArrayBuffer {
	const body = JSON.stringify({
		model: "claude-sonnet-4-5",
		max_tokens: 10,
		system: [
			{
				type: "text",
				text: "You are a helpful assistant.",
				cache_control: { type: "ephemeral" },
			},
		],
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: USER_TEXT_MARKER,
						cache_control: { type: "ephemeral" },
					},
					{ type: "text", text: "Answer briefly." },
				],
			},
		],
	});
	const bytes = new TextEncoder().encode(body);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function makeRequestMeta(clientSessionId?: string): RequestMeta {
	return {
		id: "req-mistral-cache",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId,
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
		// The REAL provider (not a hand-rolled fake): its transformRequestBody +
		// afterConvert pipeline is half of what this file is testing.
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

/** Captures the Response the proxy hands to the client (same seam as
 *  proxy-operations-upstream-402.test.ts). */
let capturedForward: Response | null = null;

const capturingForward = (async ({ response }: { response: Response }) => {
	capturedForward = response;
	return response;
}) as unknown as NonNullable<ProxyContext["forwardToClient"]>;

async function runProxy(
	account: Account,
	bodyBuffer: ArrayBuffer,
	ctx: ProxyContext,
	requestMeta: RequestMeta,
): Promise<Response | null> {
	return proxyWithAccount(
		new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		}),
		new URL("https://proxy.local/v1/messages"),
		account,
		requestMeta,
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
	bodyJson: unknown;
}

/** A valid OpenAI chat-completion response, so the success path runs once. */
const CHAT_COMPLETION_JSON = {
	id: "chatcmpl-1",
	object: "chat.completion",
	model: "mistral-large-latest",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "hi" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

function installUpstream(): {
	fetchMock: ReturnType<typeof mock>;
	requests: CapturedUpstream[];
} {
	const requests: CapturedUpstream[] = [];
	const fetchMock = mock(async (input: RequestInfo | URL) => {
		const request =
			input instanceof Request ? input : new Request(String(input));
		const bodyText = await request.clone().text();
		requests.push({
			url: request.url,
			headers: new Headers(request.headers),
			bodyText,
			bodyJson: JSON.parse(bodyText) as unknown,
		});
		return new Response(JSON.stringify(CHAT_COMPLETION_JSON), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	return { fetchMock, requests };
}

/** Deep scan: every JSON path whose key is exactly `cache_control`. */
function findCacheControl(value: unknown, path = "$"): string[] {
	const hits: string[] = [];
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			hits.push(...findCacheControl(entry, `${path}[${index}]`));
		});
		return hits;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			if (key === "cache_control") hits.push(`${path}.${key}`);
			else hits.push(...findCacheControl(entry, `${path}.${key}`));
		}
	}
	return hits;
}

describe("Mistral cache-affinity wiring through proxyWithAccount", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		capturedForward = null;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		capturedForward = null;
	});

	const expectedAffinity = deriveMistralAffinityId(SESSION_UUID);

	it.each([
		["global", "https://api.mistral.ai/v1", "api.mistral.ai"],
		["EU", "https://api.eu.mistral.ai/v1", "api.eu.mistral.ai"],
	])("pre-strips cache_control and sends x-affinity to the %s Mistral endpoint in one call", async (_label, endpoint, expectedHost) => {
		const { fetchMock, requests } = installUpstream();
		const result = await runProxy(
			makeAccount(endpoint, { id: `acc-mistral-${expectedHost}` }),
			makeRequestBody(),
			makeProxyContext(),
			makeRequestMeta(SESSION_UUID),
		);

		expect(result?.status).toBe(200);
		// The converted response also reached the client-forwarding seam.
		expect(capturedForward?.status).toBe(200);
		// Exactly one upstream call: the pre-strip exists precisely so no
		// 422-then-retry round trip is spent learning that Mistral rejects
		// cache_control.
		expect(fetchMock.mock.calls.length).toBe(1);
		expect(requests).toHaveLength(1);

		const sent = requests[0] as CapturedUpstream;
		expect(new URL(sent.url).hostname).toBe(expectedHost);
		expect(sent.url).toBe(`${endpoint}/chat/completions`);

		// Non-vacuity guard: the derivation must actually produce an id, or
		// `headers.get(...) === null` would compare equal to a null expected
		// value and assert nothing.
		expect(expectedAffinity).toMatch(/^ccflare-mistral-[0-9a-f]{32}$/);
		expect(sent.headers.get(MISTRAL_AFFINITY_HEADER)).toBe(
			expectedAffinity as string,
		);

		// The markers were in the incoming body and are gone from the wire.
		expect(findCacheControl(sent.bodyJson)).toEqual([]);
		expect(sent.bodyText).not.toContain("cache_control");
		// ...while the actual prompt content survived conversion.
		expect(JSON.stringify(sent.bodyJson)).toContain(USER_TEXT_MARKER);
	});

	it("control: a non-Mistral endpoint keeps cache_control and gets no x-affinity", async () => {
		// Proves the two Mistral assertions above are not vacuous: with the same
		// incoming body, the conversion demonstrably carries cache_control all
		// the way to upstream when nothing strips it.
		const { fetchMock, requests } = installUpstream();
		const result = await runProxy(
			makeAccount("https://api.openai.com/v1", { id: "acc-openai-control" }),
			makeRequestBody(),
			makeProxyContext(),
			makeRequestMeta(SESSION_UUID),
		);

		expect(result?.status).toBe(200);
		expect(fetchMock.mock.calls.length).toBe(1);

		const sent = requests[0] as CapturedUpstream;
		expect(new URL(sent.url).hostname).toBe("api.openai.com");
		expect(sent.headers.get(MISTRAL_AFFINITY_HEADER)).toBeNull();
		expect(findCacheControl(sent.bodyJson).length).toBeGreaterThan(0);
		expect(sent.bodyText).toContain("cache_control");
		expect(sent.bodyText).toContain(USER_TEXT_MARKER);
	});

	it("strips cache_control but sends no x-affinity when the session id is missing", async () => {
		const { requests } = installUpstream();
		const result = await runProxy(
			makeAccount("https://api.mistral.ai/v1", {
				id: "acc-mistral-no-session",
			}),
			makeRequestBody(),
			makeProxyContext(),
			// No client session id: deriveMistralAffinityId returns null.
			makeRequestMeta(undefined),
		);

		expect(result?.status).toBe(200);
		expect(requests).toHaveLength(1);

		const sent = requests[0] as CapturedUpstream;
		expect(sent.headers.get(MISTRAL_AFFINITY_HEADER)).toBeNull();
		expect(findCacheControl(sent.bodyJson)).toEqual([]);
		expect(JSON.stringify(sent.bodyJson)).toContain(USER_TEXT_MARKER);
	});
});
