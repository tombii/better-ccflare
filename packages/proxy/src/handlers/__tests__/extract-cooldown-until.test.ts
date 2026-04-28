import { describe, expect, it } from "bun:test";
import { extractCooldownUntil } from "../proxy-operations";

const ACCOUNT_ID = "acct-test";
const MIN_COOLDOWN_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function makeResponse(headers: Record<string, string> = {}): Response {
	return new Response(null, { status: 429, headers });
}

const noCache = (_id: string): number | null => null;

describe("extractCooldownUntil", () => {
	it("uses retry-after seconds header", () => {
		const before = Date.now();
		const result = extractCooldownUntil(
			makeResponse({ "retry-after": "300" }),
			ACCOUNT_ID,
			noCache,
		);
		expect(result).toBeGreaterThanOrEqual(before + 300 * 1000);
		expect(result).toBeLessThan(before + 300 * 1000 + 5000);
	});

	it("uses x-ratelimit-reset unix timestamp", () => {
		const future = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);
		const result = extractCooldownUntil(
			makeResponse({ "x-ratelimit-reset": String(future) }),
			ACCOUNT_ID,
			noCache,
		);
		expect(result).toBe(future * 1000);
	});

	it("uses HTTP-date retry-after", () => {
		const futureDate = new Date(Date.now() + 5 * 60 * 1000);
		// toUTCString() truncates to seconds — compare against second-precision floor
		const futureDateSec = Math.floor(futureDate.getTime() / 1000) * 1000;
		const result = extractCooldownUntil(
			makeResponse({ "retry-after": futureDate.toUTCString() }),
			ACCOUNT_ID,
			noCache,
		);
		expect(result).toBeGreaterThanOrEqual(futureDateSec);
	});

	it("falls through stale unix timestamp to usageCache", () => {
		const staleTs = Math.floor((Date.now() - 60 * 1000) / 1000);
		const cacheReset = Date.now() + 30 * 60 * 1000;
		const result = extractCooldownUntil(
			makeResponse({ "retry-after": String(staleTs) }),
			ACCOUNT_ID,
			() => cacheReset,
		);
		expect(result).toBe(cacheReset);
	});

	it("falls through stale HTTP-date to usageCache", () => {
		const pastDate = new Date(Date.now() - 60 * 1000).toUTCString();
		const cacheReset = Date.now() + 20 * 60 * 1000;
		const result = extractCooldownUntil(
			makeResponse({ "retry-after": pastDate }),
			ACCOUNT_ID,
			() => cacheReset,
		);
		expect(result).toBe(cacheReset);
	});

	it("falls back to 1-hour default when no headers and no cache", () => {
		const before = Date.now();
		const result = extractCooldownUntil(makeResponse(), ACCOUNT_ID, noCache);
		expect(result).toBeGreaterThanOrEqual(before + ONE_HOUR_MS);
		expect(result).toBeLessThan(before + ONE_HOUR_MS + 5000);
	});

	it("clamps small retry-after to MIN_COOLDOWN_MS", () => {
		const before = Date.now();
		const result = extractCooldownUntil(
			makeResponse({ "retry-after": "1" }),
			ACCOUNT_ID,
			noCache,
		);
		expect(result).toBeGreaterThanOrEqual(before + MIN_COOLDOWN_MS);
	});

	it("clamps imminent usageCache reset to MIN_COOLDOWN_MS", () => {
		const before = Date.now();
		const almostNow = Date.now() + 1000;
		const result = extractCooldownUntil(
			makeResponse(),
			ACCOUNT_ID,
			() => almostNow,
		);
		expect(result).toBeGreaterThanOrEqual(before + MIN_COOLDOWN_MS);
	});
});
