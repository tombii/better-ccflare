import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	clearCodexModelCacheForTests,
	getCodexModels,
} from "../codex-model-catalog";
import type { ProxyContext } from "../handlers/proxy-types";

/**
 * The per-subscription model list, and what happens when OpenAI stops
 * answering.
 *
 * This endpoint is not part of OpenAI's public REST reference — it is what the
 * Codex CLI itself calls — so the interesting case is not the happy path. It is
 * the day it changes shape or goes away: the answer must then be the last list
 * OpenAI gave for that account, not a generic catalogue that lists models the
 * subscription cannot call.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-codex",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		...overrides,
	} as Account;
}

function makeCtx(account: Account | null): ProxyContext {
	return {
		dbOps: {
			getAccount: async () => account,
		},
		refreshInFlight: new Map(),
	} as unknown as ProxyContext;
}

// Shaped after what a real subscription account returned on 2026-08-09,
// including the two entries OpenAI marks `hide` and the deprecation notices.
const LIVE_BODY = {
	models: [
		{
			slug: "gpt-5.6-sol",
			display_name: "GPT-5.6-Sol",
			description: "Latest frontier agentic coding model.",
			context_window: 272_000,
			visibility: "list",
			priority: 1,
		},
		{
			slug: "gpt-5.6-sol-wm",
			display_name: "GPT-5.6-Sol-WM",
			description: "Work Mode routing alias for GPT-5.6 Sol.",
			visibility: "hide",
			priority: 1,
		},
		{
			slug: "gpt-5.4-mini",
			display_name: "GPT-5.4-Mini",
			visibility: "list",
			priority: 23,
			upgrade: { model: "gpt-5.6-luna" },
		},
		{
			slug: "codex-auto-review",
			display_name: "Codex Auto Review",
			visibility: "hide",
			priority: 43,
		},
		// Duplicated and empty ids do not become entries.
		{ slug: "gpt-5.6-sol", visibility: "list" },
		{ slug: "  ", visibility: "list" },
	],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("getCodexModels", () => {
	it("reads the subscription's own list and keeps the useful fields", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));

		expect(listing?.source).toBe("live");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.4-mini",
		]);
		expect(listing?.models[0].contextWindow).toBe(272_000);
		// OpenAI's own ordering, not alphabetical — which would have opened the
		// list with the mini model.
		expect(listing?.models[0].id).toBe("gpt-5.6-sol");
		expect(listing?.models[0].description).toContain("frontier");
		expect(listing?.models[1].displayName).toBe("GPT-5.4-Mini");
	});

	// The payload marks routing aliases and internal models as `hide`. Reading
	// the flag beats matching on the name: the next alias OpenAI ships is
	// excluded without anyone having to learn its suffix.
	it("leaves out the entries OpenAI marks as hidden", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));
		const ids = listing?.models.map((m) => m.id) ?? [];

		expect(ids).not.toContain("gpt-5.6-sol-wm");
		expect(ids).not.toContain("codex-auto-review");
		expect(ids).toEqual(["gpt-5.6-sol", "gpt-5.4-mini"]);
	});

	// A model on its way out is a choice someone will have to undo later.
	it("carries the replacement OpenAI names for a deprecated model", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;

		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));
		const mini = listing?.models.find((m) => m.id === "gpt-5.4-mini");

		expect(mini?.supersededBy).toBe("gpt-5.6-luna");
		expect(listing?.models[0].supersededBy).toBeNull();
	});

	// The reason the cache exists.
	it("serves the last successful list when OpenAI stops answering", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-codex", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof globalThis.fetch;
		const listing = await getCodexModels("acc-codex", makeCtx(makeAccount()));

		expect(listing?.source).toBe("cached");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.4-mini",
		]);
	});

	// Measured on real accounts: two of three answer HTTP 401 here while serving
	// traffic perfectly. Their own list will never exist, and an empty field
	// forever is worse than another account's list plainly labelled as such.
	it("inherits from another account of the provider when it cannot read", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(LIVE_BODY), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as typeof globalThis.fetch;
		await getCodexModels("acc-codex", makeCtx(makeAccount()));

		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as typeof globalThis.fetch;
		const listing = await getCodexModels(
			"acc-blind",
			makeCtx(makeAccount({ id: "acc-blind" })),
		);

		expect(listing?.source).toBe("shared");
		expect(listing?.borrowedFrom).toBe("acc-codex");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.4-mini",
		]);
	});

	it("returns nothing when no account of the provider has ever read", async () => {
		clearCodexModelCacheForTests();
		globalThis.fetch = (async () =>
			new Response("nope", { status: 401 })) as typeof globalThis.fetch;

		expect(
			await getCodexModels(
				"acc-never-read",
				makeCtx(makeAccount({ id: "acc-never-read" })),
			),
		).toBeNull();
	});

	it("refuses an account that is not a Codex account", async () => {
		const listing = await getCodexModels(
			"acc-codex",
			makeCtx(makeAccount({ provider: "anthropic" })),
		);

		expect(listing).toBeNull();
	});

	it("returns nothing for an account that does not exist", async () => {
		expect(await getCodexModels("ghost", makeCtx(null))).toBeNull();
	});
});
