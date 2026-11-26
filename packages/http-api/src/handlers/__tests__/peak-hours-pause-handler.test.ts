import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	clearTokenHarborPeakCacheForTests,
	getTokenHarborPeakListing,
	getTokenHarborPeakState,
} from "@better-ccflare/proxy";
import { createAccountPeakHoursPauseHandler } from "../accounts";

function makeHandler(
	provider: string,
	options: { customEndpoint?: string | null; enabled?: 0 | 1 } = {},
) {
	const setPeakHoursPauseEnabled = mock(async () => {});
	const dbOps = {
		getAdapter: () => ({
			// The TokenHarbor gate does a second `db.get` for the endpoint
			// columns, so the mock answers by query shape rather than always
			// returning the same row.
			get: async (sql: string) =>
				sql.includes("custom_endpoint")
					? {
							custom_endpoint: options.customEndpoint ?? null,
							api_key: null,
							model_mappings: null,
						}
					: { name: "acct", provider },
			run: async () => {},
		}),
		setPeakHoursPauseEnabled,
	};
	const handler = createAccountPeakHoursPauseHandler(dbOps as never);
	const call = () =>
		handler(
			new Request("http://x/api/accounts/a1/peak-hours-pause", {
				method: "POST",
				body: JSON.stringify({ enabled: options.enabled ?? 1 }),
			}),
			"a1",
		);
	return { call, setPeakHoursPauseEnabled };
}

async function seedPeakListing() {
	const originalFetch = globalThis.fetch;
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
	try {
		await getTokenHarborPeakListing({
			id: "a1",
			name: "acct",
			provider: "anthropic-compatible",
			custom_endpoint: "https://tokenharbor.ai",
			api_key: "test-key",
		} as never);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe("peak-hours-pause handler provider gate", () => {
	it("accepts deepseek accounts", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler("deepseek");
		const res = await call();
		expect(res.status).toBe(200);
		expect(setPeakHoursPauseEnabled).toHaveBeenCalledWith("a1", true);
	});

	it("accepts zai accounts", async () => {
		expect((await makeHandler("zai").call()).status).toBe(200);
	});

	it("rejects other providers", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler("openai-compatible");
		expect((await call()).status).toBe(400);
		expect(setPeakHoursPauseEnabled).not.toHaveBeenCalled();
	});

	// anthropic-compatible is a shared provider string: only the TokenHarbor
	// host has a peak concept, so the endpoint decides, not the provider.
	it("accepts anthropic-compatible accounts on the TokenHarbor endpoint", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler(
			"anthropic-compatible",
			{ customEndpoint: "https://tokenharbor.ai" },
		);
		const res = await call();
		expect(res.status).toBe(200);
		expect(setPeakHoursPauseEnabled).toHaveBeenCalledWith("a1", true);
	});

	it("rejects anthropic-compatible accounts on any other endpoint", async () => {
		const { call, setPeakHoursPauseEnabled } = makeHandler(
			"anthropic-compatible",
			{ customEndpoint: "https://example.com" },
		);
		const res = await call();
		expect(res.status).toBe(400);
		expect(setPeakHoursPauseEnabled).not.toHaveBeenCalled();
	});
});

describe("peak-hours-pause TokenHarbor cache", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearTokenHarborPeakCacheForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearTokenHarborPeakCacheForTests();
	});

	it("clears the cached listing when disabling", async () => {
		await seedPeakListing();
		expect(getTokenHarborPeakState("a1", null)).not.toBeNull();

		const res = await makeHandler("anthropic-compatible", {
			customEndpoint: "https://tokenharbor.ai",
			enabled: 0,
		}).call();

		expect(res.status).toBe(200);
		// The badge answers from the cached listing, so it must go when the
		// toggle is off.
		expect(getTokenHarborPeakState("a1", null)).toBeNull();
	});
});
