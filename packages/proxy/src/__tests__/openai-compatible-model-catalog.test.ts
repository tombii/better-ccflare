import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearDerivedProviderModelDefaults,
	resolveProviderModelDefault,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers/proxy-types";
import {
	clearOpenAICompatibleModelCacheForTests,
	deriveFamilyDefaults,
	getOpenAICompatibleModels,
} from "../openai-compatible-model-catalog";

/**
 * The per-account model list for openai-compatible accounts, read from that
 * account's own `/v1/models` endpoint, and what happens when it stops
 * answering.
 *
 * Unlike Codex, every account here points at an arbitrary, operator-chosen
 * endpoint — there is no shared upstream — so, unlike codex-model-catalog,
 * a listing is never borrowed from another account.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-oai",
		name: "oai-account",
		provider: "openai-compatible",
		api_key: "sk-test",
		custom_endpoint: "https://api.example.com/v1",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		created_at: Date.now(),
		...overrides,
	} as Account;
}

function makeCtx(account: Account | null): ProxyContext {
	return {
		dbOps: {
			getAccount: async () => account,
		},
	} as unknown as ProxyContext;
}

const LIVE_BODY = {
	data: [
		{ id: "gpt-oss-120b" },
		{ id: "gpt-oss-20b" },
		{ id: "gpt-oss-8b" },
		// Duplicated and empty ids do not become entries.
		{ id: "gpt-oss-120b" },
		{ id: "  " },
	],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	// getOpenAICompatibleModels() writes into the process-wide derived-defaults
	// registry (provider-model-defaults.ts); left uncleared it leaks into any
	// other test file that runs in the same bun process.
	clearDerivedProviderModelDefaults();
	clearOpenAICompatibleModelCacheForTests();
});

describe("getOpenAICompatibleModels", () => {
	it("reads the account's own list and dedupes ids", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount()),
		);

		expect(listing?.source).toBe("live");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-oss-120b",
			"gpt-oss-20b",
			"gpt-oss-8b",
		]);
	});

	it("requests the standard /v1/models path with a bearer token", async () => {
		let requestedUrl: string | undefined;
		let requestedAuth: string | null | undefined;
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			requestedUrl = String(input);
			requestedAuth = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		expect(requestedUrl).toBe("https://api.example.com/v1/models");
		expect(requestedAuth).toBe("Bearer sk-test");
	});

	it("appends /v1/models when the endpoint has no /v1 suffix", async () => {
		let requestedUrl: string | undefined;
		globalThis.fetch = (async (input: string | URL | Request) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;

		await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount({ custom_endpoint: "https://api.example.com" })),
		);

		expect(requestedUrl).toBe("https://api.example.com/v1/models");
	});

	// The reason the cache exists.
	it("serves the last successful list when the endpoint stops answering", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount()),
		);

		expect(listing?.source).toBe("cached");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-oss-120b",
			"gpt-oss-20b",
			"gpt-oss-8b",
		]);
	});

	// Unlike Codex, a second account never inherits a first account's listing —
	// each openai-compatible account points at an arbitrary, unrelated endpoint.
	it("does not borrow another account's listing", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as typeof globalThis.fetch;
		const listing = await getOpenAICompatibleModels(
			"acc-other",
			makeCtx(makeAccount({ id: "acc-other" })),
		);

		expect(listing).toBeNull();
	});

	// Regression for the leak Fix 1 closes: setDerivedProviderModelDefaults used
	// to always also write the provider-wide fallback, so a second account with
	// no listing of its own could resolve to the first account's private
	// endpoint's model ids. openai-compatible must opt out of that sharing.
	it("does not let one account's derived defaults resolve for another account", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount()));

		expect(
			resolveProviderModelDefault("openai-compatible", "opus", "acc-oai"),
		).toBe("gpt-oss-120b");
		expect(
			resolveProviderModelDefault(
				"openai-compatible",
				"opus",
				"acc-other-account",
			),
		).toBeUndefined();
		// No accountId at all resolves through the (now never-populated)
		// provider-wide map — must also stay empty.
		expect(
			resolveProviderModelDefault("openai-compatible", "opus"),
		).toBeUndefined();
	});

	it("treats a listing with no usable models as a failure", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		expect(
			await getOpenAICompatibleModels("acc-oai", makeCtx(makeAccount())),
		).toBeNull();

		// And the account is not stuck: a later real answer still lands.
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount()),
		);

		expect(listing?.source).toBe("live");
	});

	it("returns nothing for an account with no API key", async () => {
		expect(
			await getOpenAICompatibleModels(
				"acc-oai",
				makeCtx(makeAccount({ api_key: null })),
			),
		).toBeNull();
	});

	it("refuses an account that is not openai-compatible", async () => {
		const listing = await getOpenAICompatibleModels(
			"acc-oai",
			makeCtx(makeAccount({ provider: "anthropic" })),
		);

		expect(listing).toBeNull();
	});

	it("returns nothing for an account that does not exist", async () => {
		expect(await getOpenAICompatibleModels("ghost", makeCtx(null))).toBeNull();
	});
});

describe("deriveFamilyDefaults", () => {
	it("maps fable/opus to the frontier model, sonnet next, haiku after", () => {
		const defaults = deriveFamilyDefaults([
			{ id: "big", displayName: "big" },
			{ id: "mid", displayName: "mid" },
			{ id: "small", displayName: "small" },
		]);

		expect(defaults).toEqual({
			fable: "big",
			opus: "big",
			sonnet: "mid",
			haiku: "small",
		});
	});

	it("degrades to the last available model for a shorter list", () => {
		const defaults = deriveFamilyDefaults([
			{ id: "only", displayName: "only" },
		]);

		expect(defaults).toEqual({
			fable: "only",
			opus: "only",
			sonnet: "only",
			haiku: "only",
		});
	});

	it("returns an empty map for an empty list", () => {
		expect(deriveFamilyDefaults([])).toEqual({});
	});
});
