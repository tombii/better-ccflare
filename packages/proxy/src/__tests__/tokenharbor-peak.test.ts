/**
 * TokenHarbor peak pricing: window parsing, listing extraction, and the
 * model-aware skip decision.
 *
 * Reference calendar (2026-09, UTC): 23 Wed, 26 Sat, 27 Sun.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	clearTokenHarborPeakCacheForTests,
	extractPeakPricedModels,
	getPeakPricedModelIds,
	getTokenHarborPeakListing,
	getTokenHarborPeakState,
	isInOffPeakWindow,
	isPeakAffected,
	isTokenHarborEndpoint,
	parseOffPeakWindow,
	peekTokenHarborPeakListing,
} from "../tokenharbor-peak";

const WED = (h: number, m = 0) => Date.UTC(2026, 8, 23, h, m);
const SAT = (h: number, m = 0) => Date.UTC(2026, 8, 26, h, m);
const SUN = (h: number, m = 0) => Date.UTC(2026, 8, 27, h, m);

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "th-1",
		name: "tokenharbor",
		provider: "anthropic-compatible",
		custom_endpoint: "https://tokenharbor.ai",
		api_key: "test-key",
		peak_hours_pause_enabled: true,
		...overrides,
	} as Account;
}

describe("parseOffPeakWindow", () => {
	it("parses the listing's en-dash UTC window", () => {
		expect(parseOffPeakWindow("14:00–00:00 UTC")).toEqual({
			startMin: 840,
			endMin: 1440,
		});
	});

	it("accepts hyphen and tilde separators and lower-case UTC", () => {
		for (const spec of [
			"14:00-00:00 UTC",
			"14:00 ~ 00:00 utc",
			"  14:00–00:00 UTC  ",
		]) {
			expect(parseOffPeakWindow(spec)).toEqual({
				startMin: 840,
				endMin: 1440,
			});
		}
	});

	it("parses a wrapping window", () => {
		expect(parseOffPeakWindow("22:30–06:15 UTC")).toEqual({
			startMin: 1350,
			endMin: 375,
		});
	});

	it("returns null for malformed, zoned, or empty windows", () => {
		for (const spec of [
			null,
			undefined,
			"",
			"14:00",
			"14:00–00:00",
			"14:00–00:00 CET",
			"25:00–00:00 UTC",
			"14:60–00:00 UTC",
			"14:00–14:00 UTC",
			"24:00–00:00 UTC",
		]) {
			expect(parseOffPeakWindow(spec as string | null | undefined)).toBeNull();
		}
	});
});

describe("isInOffPeakWindow", () => {
	const window = { startMin: 840, endMin: 1440 };

	it("is off-peak from 14:00 UTC inclusive to midnight exclusive", () => {
		expect(isInOffPeakWindow(window, WED(13, 59))).toBe(false);
		expect(isInOffPeakWindow(window, WED(14, 0))).toBe(true);
		expect(isInOffPeakWindow(window, WED(23, 59))).toBe(true);
		expect(isInOffPeakWindow(window, WED(0, 0))).toBe(false);
	});

	it("applies every day of the week, including weekends", () => {
		expect(isInOffPeakWindow(window, SAT(21, 0))).toBe(true);
		expect(isInOffPeakWindow(window, SUN(15, 0))).toBe(true);
		expect(isInOffPeakWindow(window, SAT(2, 0))).toBe(false);
		expect(isInOffPeakWindow(window, SUN(2, 0))).toBe(false);
	});

	it("handles a wrapping window", () => {
		const wrap = { startMin: 1350, endMin: 375 };
		expect(isInOffPeakWindow(wrap, WED(22, 30))).toBe(true);
		expect(isInOffPeakWindow(wrap, WED(3, 0))).toBe(true);
		expect(isInOffPeakWindow(wrap, WED(12, 0))).toBe(false);
	});

	it("rejects a non-finite timestamp", () => {
		expect(isInOffPeakWindow(window, Number.NaN)).toBe(false);
	});
});

describe("extractPeakPricedModels", () => {
	it("keeps only models carrying a parseable off_peak window", () => {
		const models = extractPeakPricedModels({
			data: [
				{
					id: "deepseek-v4-pro",
					pricing: { off_peak: { window: "14:00–00:00 UTC" } },
				},
				{ id: "claude-opus-5.5", pricing: { off_peak: null } },
				{ id: "glm-5.3", pricing: {} },
				{ id: "no-pricing" },
				{
					id: "bad-window",
					pricing: { off_peak: { window: "sometime" } },
				},
			],
		});
		expect([...models.keys()]).toEqual(["deepseek-v4-pro"]);
		expect(models.get("deepseek-v4-pro")).toEqual({
			startMin: 840,
			endMin: 1440,
		});
	});

	it("tolerates a missing or malformed body", () => {
		expect(extractPeakPricedModels({}).size).toBe(0);
		expect(extractPeakPricedModels({ data: [] }).size).toBe(0);
		expect(
			extractPeakPricedModels({ data: [null, { id: 42 }] } as never).size,
		).toBe(0);
	});
});

describe("isTokenHarborEndpoint", () => {
	it("matches the exact host only", () => {
		expect(
			isTokenHarborEndpoint(
				makeAccount({ custom_endpoint: "https://tokenharbor.ai" }),
			),
		).toBe(true);
		expect(
			isTokenHarborEndpoint(
				makeAccount({ custom_endpoint: "https://tokenharbor.ai/v1" }),
			),
		).toBe(true);
		expect(
			isTokenHarborEndpoint(
				makeAccount({ custom_endpoint: "https://evil-tokenharbor.ai" }),
			),
		).toBe(false);
		expect(
			isTokenHarborEndpoint(
				makeAccount({ custom_endpoint: "https://tokenharbor.ai.evil.test" }),
			),
		).toBe(false);
		expect(isTokenHarborEndpoint(null)).toBe(false);
	});
});

describe("isPeakAffected", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		clearTokenHarborPeakCacheForTests();
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearTokenHarborPeakCacheForTests();
	});

	function stubListing() {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "deepseek-v4-pro",
							pricing: { off_peak: { window: "14:00–00:00 UTC" } },
						},
						{ id: "claude-opus-5.5", pricing: { off_peak: null } },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof globalThis.fetch;
	}

	it("routes normally when the toggle is off", async () => {
		stubListing();
		const account = makeAccount({ peak_hours_pause_enabled: false });
		await getTokenHarborPeakListing(account);
		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(false);
	});

	it("routes normally when no listing has been fetched", () => {
		const account = makeAccount();
		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(false);
	});

	it("skips a peak-priced model during peak only", async () => {
		stubListing();
		const account = makeAccount();
		await getTokenHarborPeakListing(account);
		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
		expect(isPeakAffected(account, "deepseek-v4-pro", WED(14))).toBe(false);
		expect(isPeakAffected(account, "deepseek-v4-pro", SAT(2))).toBe(true);
		expect(isPeakAffected(account, "deepseek-v4-pro", SAT(21))).toBe(false);
	});

	it("never skips a flat-priced model", async () => {
		stubListing();
		const account = makeAccount();
		await getTokenHarborPeakListing(account);
		expect(isPeakAffected(account, "claude-opus-5.5", WED(2))).toBe(false);
		expect(isPeakAffected(account, "unknown-model", WED(2))).toBe(false);
	});

	it("judges the model the account would actually call", async () => {
		stubListing();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				"claude-opus-5-5": "deepseek-v4-pro",
			}),
		} as Partial<Account>);
		await getTokenHarborPeakListing(account);
		// The client asked for a Claude model, but this account remaps it onto a
		// peak-priced one, so the request is peak-affected.
		expect(isPeakAffected(account, "claude-opus-5-5", WED(2))).toBe(true);
	});

	it("ignores a provider-routing suffix on the mapped model", async () => {
		stubListing();
		// mapModelName keeps a `{"only":[...]}` suffix on the value it returns
		// (the request rewriter reads it back out), but the suffix is not part of
		// the listing's model id.
		const account = makeAccount({
			model_mappings: JSON.stringify({
				"claude-opus-5-5": 'deepseek-v4-pro {"only":["example"]}',
			}),
		} as Partial<Account>);
		await getTokenHarborPeakListing(account);
		expect(isPeakAffected(account, "claude-opus-5-5", WED(2))).toBe(true);
	});

	it("ignores a listing once the account's endpoint has moved off TokenHarbor", async () => {
		stubListing();
		const account = makeAccount();
		await getTokenHarborPeakListing(account);
		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
		// The same row (same id, toggle and cached listing) was edited onto
		// another gateway: its prices are not TokenHarbor's.
		const moved = {
			...account,
			custom_endpoint: "https://other-gateway.example",
		};
		expect(isPeakAffected(moved, "deepseek-v4-pro", WED(2))).toBe(false);
	});

	it("ignores a listing once the account's provider has changed", async () => {
		stubListing();
		const account = makeAccount();
		await getTokenHarborPeakListing(account);
		const reprovided = { ...account, provider: "zai" };
		expect(isPeakAffected(reprovided, "deepseek-v4-pro", WED(2))).toBe(false);
	});

	it("has no opinion without a model", async () => {
		stubListing();
		const account = makeAccount();
		await getTokenHarborPeakListing(account);
		expect(isPeakAffected(account, null, WED(2))).toBe(false);
		expect(isPeakAffected(account, "  ", WED(2))).toBe(false);
	});

	it("fails open when the fetch fails and nothing is cached", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", {
				status: 500,
			})) as unknown as typeof globalThis.fetch;
		const account = makeAccount();
		expect(await getTokenHarborPeakListing(account)).toBeNull();
		expect(peekTokenHarborPeakListing(account.id)).toBeNull();
		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(false);
	});

	it("reports peak state per account and per model", async () => {
		stubListing();
		const account = makeAccount();
		await getTokenHarborPeakListing(account);
		expect(getTokenHarborPeakState(account.id, null, WED(2))).toEqual({
			active: true,
		});
		expect(getTokenHarborPeakState(account.id, null, WED(15))).toEqual({
			active: false,
		});
		expect(
			getTokenHarborPeakState(account.id, "deepseek-v4-pro", WED(2)),
		).toEqual({ active: true });
		// A flat-priced model has no window, so there is nothing to report.
		expect(
			getTokenHarborPeakState(account.id, "claude-opus-5.5", WED(2)),
		).toBeNull();
		expect(getTokenHarborPeakState("unknown", null, WED(2))).toBeNull();
	});

	it("resolves a remapped client model for the summary path", async () => {
		stubListing();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				"claude-opus-5-5": "deepseek-v4-pro",
			}),
		} as Partial<Account>);
		await getTokenHarborPeakListing(account);
		// usage-collector and /api/requests only have the account id and the
		// model the client named, so the helper must resolve the remap itself.
		expect(
			getTokenHarborPeakState(account.id, "claude-opus-5-5", WED(2)),
		).toEqual({ active: true });
		// An upstream id passed directly still matches.
		expect(
			getTokenHarborPeakState(account.id, "deepseek-v4-pro", WED(2)),
		).toEqual({ active: true });
	});

	it("exposes the peak-priced ids only once a listing exists", async () => {
		const account = makeAccount();
		expect(getPeakPricedModelIds(account.id)).toBeNull();
		stubListing();
		await getTokenHarborPeakListing(account);
		expect(getPeakPricedModelIds(account.id)).toEqual(["deepseek-v4-pro"]);
	});

	it("keeps serving the last good listing after a failed refetch", async () => {
		stubListing();
		const account = makeAccount();
		await getTokenHarborPeakListing(account);
		globalThis.fetch = (async () =>
			new Response("nope", {
				status: 500,
			})) as unknown as typeof globalThis.fetch;
		clearTokenHarborPeakCacheForTests();
		// Repopulate, then expire it by moving the clock past the TTL.
		stubListing();
		await getTokenHarborPeakListing(account);
		const listing = peekTokenHarborPeakListing(account.id);
		if (!listing) throw new Error("expected a cached listing");
		listing.fetchedAt = Date.now() - 2 * 60 * 60 * 1000;
		globalThis.fetch = (async () =>
			new Response("nope", {
				status: 500,
			})) as unknown as typeof globalThis.fetch;
		const again = await getTokenHarborPeakListing(account);
		expect(again?.models.size).toBe(1);
	});
});
