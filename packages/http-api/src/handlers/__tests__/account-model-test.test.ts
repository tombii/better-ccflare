import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, APIContext } from "@better-ccflare/types";
import { createAccountModelTestHandler } from "../model-test";

interface ModelTestBody {
	ok: boolean;
	status: number;
	durationMs: number;
	accountId: string;
	model: string;
	error?: string;
}

/** Minimal healthy account row; override only what a test cares about. */
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
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

function makeContext(account: Account | null): APIContext {
	return {
		dbOps: {
			getAccount: async (id: string) =>
				account && account.id === id ? account : null,
		},
		runtime: { port: 8765, tlsEnabled: false },
		internalProbeSecret: "probe-secret",
	} as unknown as APIContext;
}

function makeRequest(body: unknown): Request {
	return new Request("http://localhost/api/accounts/acc-1/test-model", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// The probe is a self-loop through the server's own proxy port, so global
// fetch is the boundary these tests control. Every assertion about "no
// request left the process" reads this log.
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

/** Global-fetch replacement that records each call, then answers with
 * `respond`. Keeping the log outside the mock keeps the assertions plain
 * arrays instead of mock-API introspection. */
function stubFetch(respond: () => Promise<Response>): typeof globalThis.fetch {
	return mock(async (url: string | URL | Request, init?: RequestInit) => {
		fetchCalls.push({ url: String(url), init: init ?? {} });
		return respond();
	}) as unknown as typeof globalThis.fetch;
}

describe("POST /api/accounts/:id/test-model", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		fetchCalls = [];
		globalThis.fetch = stubFetch(
			async () => new Response("{}", { status: 200 }),
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns 404 for an unknown account", async () => {
		const handler = createAccountModelTestHandler(makeContext(makeAccount()));

		const response = await handler(
			makeRequest({ model: "gpt-5.6-sol" }),
			"does-not-exist",
		);

		expect(response.status).toBe(404);
		expect(fetchCalls).toHaveLength(0);
	});

	it("returns 400 when the body carries no usable model", async () => {
		const handler = createAccountModelTestHandler(makeContext(makeAccount()));

		expect((await handler(makeRequest({}), "acc-1")).status).toBe(400);
		expect((await handler(makeRequest({ model: "   " }), "acc-1")).status).toBe(
			400,
		);
		expect((await handler(makeRequest({ model: 42 }), "acc-1")).status).toBe(
			400,
		);
		expect(fetchCalls).toHaveLength(0);
	});

	// The non-obvious part of the design. selectAccountsForRequest silently
	// falls back to normal pool selection when the forced account is unusable,
	// so a probe fired at a manually-paused account would come back green
	// describing SOME OTHER account. The pre-flight guard has to refuse before
	// anything leaves the process — asserting the refusal alone would not
	// prove that, hence the call-count assertion.
	it("refuses a non-resumably-paused account before any request is sent", async () => {
		const account = makeAccount({ paused: true, pause_reason: "manual" });
		const handler = createAccountModelTestHandler(makeContext(account));

		const response = await handler(
			makeRequest({ model: "gpt-5.6-sol" }),
			"acc-1",
		);
		const body = (await response.json()) as ModelTestBody;

		expect(response.status).toBe(200);
		expect(body.ok).toBe(false);
		// 0 = no HTTP status was ever obtained.
		expect(body.status).toBe(0);
		expect(body.error).toContain("paused");
		expect(body.error).toContain("manual");
		expect(body.model).toBe("gpt-5.6-sol");
		expect(body.accountId).toBe("acc-1");
		expect(fetchCalls).toHaveLength(0);
	});

	it("refuses an account that needs re-authentication, for the same reason", async () => {
		const account = makeAccount({ requires_reauth: true });
		const handler = createAccountModelTestHandler(makeContext(account));

		const response = await handler(
			makeRequest({ model: "gpt-5.6-sol" }),
			"acc-1",
		);
		const body = (await response.json()) as ModelTestBody;

		expect(body.ok).toBe(false);
		expect(body.status).toBe(0);
		expect(body.error).toContain("re-authentication");
		expect(fetchCalls).toHaveLength(0);
	});

	// The mirror image: the guard must not degenerate into "refuse anything
	// paused". An overage pause with auto-resume enabled is exactly the case
	// the forced-account path does honor, so the probe has to go out.
	it("still probes an overage-paused account with auto-resume enabled", async () => {
		const account = makeAccount({
			paused: true,
			pause_reason: "overage",
			auto_pause_on_overage_enabled: true,
		});
		const handler = createAccountModelTestHandler(makeContext(account));

		const response = await handler(
			makeRequest({ model: "gpt-5.6-sol" }),
			"acc-1",
		);
		const body = (await response.json()) as ModelTestBody;

		expect(body.ok).toBe(true);
		expect(fetchCalls).toHaveLength(1);
	});

	it("passes the upstream error through raw, with its status", async () => {
		// Verbatim shape of the failure this feature exists to expose: the
		// model is in OpenAI's catalogue, the subscription still refuses it.
		const upstreamBody = JSON.stringify({
			error: {
				message: "The model `gpt-5.3-codex` is not available on your plan.",
				type: "invalid_request_error",
				code: "model_not_found",
			},
		});
		globalThis.fetch = stubFetch(
			async () => new Response(upstreamBody, { status: 400 }),
		);
		const handler = createAccountModelTestHandler(makeContext(makeAccount()));

		const response = await handler(
			makeRequest({ model: "gpt-5.3-codex" }),
			"acc-1",
		);
		const body = (await response.json()) as ModelTestBody;

		expect(response.status).toBe(200);
		expect(body.ok).toBe(false);
		expect(body.status).toBe(400);
		// Raw: byte-for-byte what the upstream said, not a summary of it.
		expect(body.error).toBe(upstreamBody);
		expect(body.model).toBe("gpt-5.3-codex");
		expect(typeof body.durationMs).toBe("number");
	});

	it("reports a transport failure as status 0 carrying the thrown message", async () => {
		globalThis.fetch = stubFetch(async () => {
			throw new Error("The operation timed out.");
		});
		const handler = createAccountModelTestHandler(makeContext(makeAccount()));

		const response = await handler(
			makeRequest({ model: "gpt-5.6-sol" }),
			"acc-1",
		);
		const body = (await response.json()) as ModelTestBody;

		expect(body.ok).toBe(false);
		expect(body.status).toBe(0);
		expect(body.error).toBe("The operation timed out.");
	});

	it("sends one minimal request pinned to that account and model", async () => {
		const handler = createAccountModelTestHandler(makeContext(makeAccount()));

		const response = await handler(
			makeRequest({ model: "gpt-5.6-sol" }),
			"acc-1",
		);
		const body = (await response.json()) as ModelTestBody;

		expect(body.ok).toBe(true);
		expect(body.status).toBe(200);
		expect(body.error).toBeUndefined();

		expect(fetchCalls).toHaveLength(1);
		const { url, init } = fetchCalls[0];
		expect(url).toBe("http://localhost:8765/v1/messages");
		expect(init.method).toBe("POST");

		const headers = new Headers(init.headers);
		// Pinned to this account, and marked as a synthetic probe so it does
		// not dirty session state or request logs.
		expect(headers.get("x-better-ccflare-account-id")).toBe("acc-1");
		expect(headers.get("x-better-ccflare-bypass-session")).toBe("true");
		expect(headers.get("x-better-ccflare-auto-refresh")).toBe("true");
		expect(headers.get("x-better-ccflare-internal-probe-secret")).toBe(
			"probe-secret",
		);

		// Real-client headers. Without them Anthropic rejects the probe with a
		// rate-limit-window-less 429 even when the model and account are perfect
		// — measured in production with a model serving traffic with HTTP 200 at
		// the same instant. This test exists so nobody removes them as decoration.
		expect(headers.get("user-agent")).toMatch(/^claude-cli\//);
		expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
		expect(headers.get("x-app")).toBe("cli");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");

		const sent = JSON.parse(String(init.body)) as {
			model: string;
			system?: Array<{ type: string; text: string }>;
			max_tokens: number;
			stream?: boolean;
			messages: Array<{ role: string; content: string }>;
		};
		expect(sent.model).toBe("gpt-5.6-sol");
		// Anthropic answers a windowless 429 when the probe does not look like
		// Claude Code, and the check is sensitive to the exact text. Pinned here
		// because dropping it reintroduces a silent false negative.
		expect(sent.system?.[0]?.text).toBe(
			"You are Claude Code, Anthropic's official CLI for Claude.",
		);
		// Deliberately cheap, but in the auto-refresh probe format, which the
		// upstream accepts.
		expect(sent.max_tokens).toBe(4);
		expect(sent.stream).toBeUndefined();
		expect(sent.messages).toHaveLength(1);
	});

	// Not every failure says something about the MODEL. A 429 (the account has
	// no capacity right now) leaves "does this plan accept this model?"
	// unanswered — reporting it as a failure would discard a good model. A 400
	// is a refusal of the model itself and must keep arriving as a failure.
	it("marks a 429 as inconclusive but leaves a 400 as a plain failure", async () => {
		const handler = createAccountModelTestHandler(makeContext(makeAccount()));

		globalThis.fetch = (async () =>
			new Response('{"type":"error"}', { status: 429 })) as typeof fetch;
		let body = (await (
			await handler(makeRequest({ model: "claude-opus-4-8" }), "acc-1")
		).json()) as { ok: boolean; inconclusive?: boolean };
		expect(body.ok).toBe(false);
		expect(body.inconclusive).toBe(true);

		globalThis.fetch = (async () =>
			new Response('{"detail":"model not supported"}', {
				status: 400,
			})) as typeof fetch;
		body = (await (
			await handler(makeRequest({ model: "gpt-5.3-codex" }), "acc-1")
		).json()) as { ok: boolean; inconclusive?: boolean };
		expect(body.ok).toBe(false);
		expect(body.inconclusive).toBeFalsy();
	});

	// CLAUDE.md forbids scripted traffic on real Anthropic accounts. The check
	// refuses those by default and says how to opt in, rather than quietly
	// exposing an account the operator may not own.
	it("refuses Anthropic accounts by default and names the opt-in variable", async () => {
		const handler = createAccountModelTestHandler(
			makeContext(makeAccount({ provider: "anthropic" })),
		);

		const body = (await (
			await handler(makeRequest({ model: "claude-opus-4-8" }), "acc-1")
		).json()) as { ok: boolean; error?: string };

		expect(body.ok).toBe(false);
		expect(String(body.error)).toContain("CCFLARE_ALLOW_ANTHROPIC_MODEL_TEST");
		expect(fetchCalls).toHaveLength(0);
	});

	it("probes an Anthropic account once the operator opts in", async () => {
		process.env.CCFLARE_ALLOW_ANTHROPIC_MODEL_TEST = "1";
		try {
			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ model: "claude-opus-4-8" }), {
					status: 200,
				})) as typeof fetch;
			const handler = createAccountModelTestHandler(
				makeContext(makeAccount({ provider: "anthropic" })),
			);

			const body = (await (
				await handler(makeRequest({ model: "claude-opus-4-8" }), "acc-1")
			).json()) as { ok: boolean };

			expect(body.ok).toBe(true);
		} finally {
			delete process.env.CCFLARE_ALLOW_ANTHROPIC_MODEL_TEST;
		}
	});

	// An account mapping or a model fallback can make the pipeline answer about
	// a different model. Reporting that as success would mark a model accepted
	// on an account that cannot call it.
	it("refuses to judge when the upstream answered about another model", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ model: "gpt-5.4-mini" }), {
				status: 200,
			})) as typeof fetch;
		const handler = createAccountModelTestHandler(makeContext(makeAccount()));

		const body = (await (
			await handler(makeRequest({ model: "gpt-5.3-codex" }), "acc-1")
		).json()) as {
			ok: boolean;
			inconclusive?: boolean;
			answeredModel?: string;
			error?: string;
		};

		expect(body.ok).toBe(false);
		expect(body.inconclusive).toBe(true);
		expect(body.answeredModel).toBe("gpt-5.4-mini");
		expect(String(body.error)).toContain("never exercised");
	});

	it("returns 503 when the server runtime port is not wired up", async () => {
		const context = {
			dbOps: { getAccount: async () => makeAccount() },
			internalProbeSecret: "probe-secret",
		} as unknown as APIContext;
		const handler = createAccountModelTestHandler(context);

		const response = await handler(
			makeRequest({ model: "gpt-5.6-sol" }),
			"acc-1",
		);

		expect(response.status).toBe(503);
		expect(fetchCalls).toHaveLength(0);
	});
});
