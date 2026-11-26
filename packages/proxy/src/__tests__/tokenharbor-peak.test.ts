/**
 * TokenHarbor peak pricing: window parsing, listing extraction, and the
 * model-aware skip decision.
 *
 * Reference calendar (2026-09, UTC): 23 Wed, 26 Sat, 27 Sun.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	clearTokenHarborPeakCacheForAccount,
	clearTokenHarborPeakCacheForTests,
	extractPeakPricedModels,
	getPeakPricedModelIds,
	getTokenHarborPeakListing,
	getTokenHarborPeakState,
	isInOffPeakWindow,
	isPeakAffected,
	isTokenHarborAccount,
	isTokenHarborEndpoint,
	parseOffPeakWindow,
	parseTokenHarborPeakGraceHours,
	peekTokenHarborPeakListing,
} from "../tokenharbor-peak";

const WED = (h: number, m = 0) => Date.UTC(2026, 8, 23, h, m);
const SAT = (h: number, m = 0) => Date.UTC(2026, 8, 26, h, m);
const SUN = (h: number, m = 0) => Date.UTC(2026, 8, 27, h, m);

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "th-1",
		name: "tokenharbor",
		provider: "tokenharbor",
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

describe("isTokenHarborAccount", () => {
	it("accepts the first-class provider whatever its endpoint", () => {
		expect(isTokenHarborAccount(makeAccount())).toBe(true);
		expect(
			isTokenHarborAccount(
				makeAccount({ custom_endpoint: "https://mirror.example" }),
			),
		).toBe(true);
	});

	it("accepts legacy anthropic-compatible rows only on TokenHarbor's host", () => {
		expect(
			isTokenHarborAccount(makeAccount({ provider: "anthropic-compatible" })),
		).toBe(true);
		expect(
			isTokenHarborAccount(
				makeAccount({
					provider: "anthropic-compatible",
					custom_endpoint: "https://other-gateway.example",
				}),
			),
		).toBe(false);
		expect(isTokenHarborAccount(makeAccount({ provider: "zai" }))).toBe(false);
		expect(isTokenHarborAccount(null)).toBe(false);
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

	it("keeps honouring a legacy anthropic-compatible TokenHarbor row", async () => {
		stubListing();
		const account = makeAccount({ provider: "anthropic-compatible" });
		await getTokenHarborPeakListing(account);
		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
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

	it("fetches from tokenharbor.ai when a first-class row has no custom endpoint", async () => {
		let requestedUrl = "";
		globalThis.fetch = (async (input: string) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;
		const account = makeAccount({ custom_endpoint: null });

		await getTokenHarborPeakListing(account);

		expect(requestedUrl).toBe("https://tokenharbor.ai/v1/models");
	});

	it("builds the listing URL without duplicating slashes", async () => {
		let requestedUrl = "";
		globalThis.fetch = (async (input: string) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;
		const cases: Array<[string, Account["custom_endpoint"], string]> = [
			[
				"th-slashy",
				"https://tokenharbor.ai///",
				"https://tokenharbor.ai/v1/models",
			],
			[
				"th-plain",
				"https://tokenharbor.ai",
				"https://tokenharbor.ai/v1/models",
			],
			[
				"th-v1",
				"https://mirror.example/v1/",
				"https://mirror.example/v1/models",
			],
		];

		for (const [id, endpoint, expected] of cases) {
			await getTokenHarborPeakListing(
				makeAccount({ id, custom_endpoint: endpoint }),
			);
			expect(requestedUrl).toBe(expected);
		}
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

	it("discards a listing that resolves after the account cache was cleared", async () => {
		let resolveResponse!: (response: Response) => void;
		const gate = new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
		globalThis.fetch = (() => gate) as unknown as typeof globalThis.fetch;
		const account = makeAccount();

		const inFlight = getTokenHarborPeakListing(account);
		// Disabling peak hours (or removing the account) clears the cache while
		// the request is still on the wire.
		clearTokenHarborPeakCacheForAccount(account.id);
		resolveResponse(
			new Response(
				JSON.stringify({
					data: [
						{
							id: "deepseek-v4-pro",
							pricing: { off_peak: { window: "14:00–00:00 UTC" } },
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		expect(await inFlight).toBeNull();
		expect(peekTokenHarborPeakListing(account.id)).toBeNull();
		expect(getTokenHarborPeakState(account.id, null)).toBeNull();
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

describe("parseTokenHarborPeakGraceHours", () => {
	it("defaults to 24 hours when unset", () => {
		expect(parseTokenHarborPeakGraceHours({})).toBe(24);
		expect(
			parseTokenHarborPeakGraceHours({
				CCFLARE_TOKENHARBOR_PEAK_GRACE_HOURS: undefined,
			}),
		).toBe(24);
	});

	it("accepts 0 to disable the grace", () => {
		expect(
			parseTokenHarborPeakGraceHours({
				CCFLARE_TOKENHARBOR_PEAK_GRACE_HOURS: "0",
			}),
		).toBe(0);
	});

	it("falls back to 24 for invalid or negative values", () => {
		for (const raw of ["", "abc", "-1", "NaN", "Infinity"]) {
			expect(
				parseTokenHarborPeakGraceHours({
					CCFLARE_TOKENHARBOR_PEAK_GRACE_HOURS: raw,
				}),
			).toBe(24);
		}
	});
});

describe("TokenHarbor peak grace near the shared reset", () => {
	let originalFetch: typeof globalThis.fetch;
	const GRACE_ENV_KEY = "CCFLARE_TOKENHARBOR_PEAK_GRACE_HOURS";
	const savedEnv = process.env[GRACE_ENV_KEY];
	const HOUR_MS = 60 * 60 * 1000;

	beforeEach(() => {
		clearTokenHarborPeakCacheForTests();
		usageCache.clear();
		delete process.env[GRACE_ENV_KEY];
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearTokenHarborPeakCacheForTests();
		usageCache.clear();
		if (savedEnv === undefined) delete process.env[GRACE_ENV_KEY];
		else process.env[GRACE_ENV_KEY] = savedEnv;
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
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof globalThis.fetch;
	}

	/** Real payload shape, positioned at a chosen reset relative to `ts`. */
	function usageResettingAt(ts: number, resetInHours: number) {
		return {
			on_plan: true,
			plan_used_pct: 40,
			used_pct: 10,
			reset_at: new Date(ts + resetInHours * HOUR_MS).toISOString(),
			plan_exhausted: false,
			exhausted: false,
		};
	}

	async function primeListing(account: Account) {
		stubListing();
		await getTokenHarborPeakListing(account);
	}

	it("stops skipping a peak-priced model inside the last 24h before reset", async () => {
		const account = makeAccount();
		await primeListing(account);
		usageCache.set(account.id, usageResettingAt(WED(2), 23) as never);

		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(false);
	});

	it("still skips when the reset is further out than the grace", async () => {
		const account = makeAccount();
		await primeListing(account);
		usageCache.set(account.id, usageResettingAt(WED(2), 25) as never);

		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
	});

	it("can be disabled with 0", async () => {
		const account = makeAccount();
		await primeListing(account);
		usageCache.set(account.id, usageResettingAt(WED(2), 1) as never);
		process.env[GRACE_ENV_KEY] = "0";

		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
	});

	it("does not spend a grace period into an exhausted allowance", async () => {
		const account = makeAccount();
		await primeListing(account);
		usageCache.set(account.id, {
			...usageResettingAt(WED(2), 1),
			plan_exhausted: true,
		} as never);

		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
	});

	it("does not apply without cached usage data", async () => {
		const account = makeAccount();
		await primeListing(account);

		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
	});

	it("treats a reset already in the past as no grace", async () => {
		const account = makeAccount();
		await primeListing(account);
		usageCache.set(account.id, usageResettingAt(WED(2), -1) as never);

		expect(isPeakAffected(account, "deepseek-v4-pro", WED(2))).toBe(true);
	});

	it("agrees with routing in the badge state, including a historical ts", async () => {
		const account = makeAccount();
		await primeListing(account);
		usageCache.set(account.id, usageResettingAt(WED(2), 23) as never);

		expect(getTokenHarborPeakState(account.id, null, WED(2))).toEqual({
			active: false,
		});
		expect(
			getTokenHarborPeakState(account.id, "deepseek-v4-pro", WED(2)),
		).toEqual({ active: false });
		// Grace is judged against the ts it is asked about, so a request from
		// long before the grace window still reports peak.
		expect(
			getTokenHarborPeakState(account.id, null, WED(2) - 48 * HOUR_MS),
		).toEqual({ active: true });
	});

	it("can report the price window at a timestamp without the live grace", async () => {
		const account = makeAccount();
		await primeListing(account);
		usageCache.set(account.id, usageResettingAt(WED(2), 23) as never);

		// Inside grace the live badge follows routing and reads off peak…
		expect(getTokenHarborPeakState(account.id, null, WED(2))).toEqual({
			active: false,
		});
		// …while a request summary keeps the window it was billed under.
		expect(getTokenHarborPeakState(account.id, null, WED(2), false)).toEqual({
			active: true,
		});
		expect(
			getTokenHarborPeakState(account.id, "deepseek-v4-pro", WED(2), false),
		).toEqual({ active: true });

		// Outside the peak window both agree.
		expect(getTokenHarborPeakState(account.id, null, WED(15))).toEqual({
			active: false,
		});
		expect(getTokenHarborPeakState(account.id, null, WED(15), false)).toEqual({
			active: false,
		});
	});
});
