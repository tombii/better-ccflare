import { describe, expect, it } from "bun:test";
import { ZaiProvider } from "../providers/zai/provider";

/**
 * S5b (spec TEST-SPEC.md §4) — `ZaiProvider.parseRateLimitFromBody` in
 * isolation. PINS pre-existing behaviour (no fix-dependent invariant here);
 * exists to pin the body-parsing contract that S5 exercises indirectly
 * through `processProxyResponse`.
 */
describe("ZaiProvider.parseRateLimitFromBody", () => {
	function makeFixture(): { resetUtcMs: number; body: string } {
		const resetUtcMs = Math.floor((Date.now() + 20_000) / 1000) * 1000;
		const sg = new Date(resetUtcMs + 8 * 3600_000);
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp =
			`${sg.getUTCFullYear()}-${pad(sg.getUTCMonth() + 1)}-${pad(sg.getUTCDate())} ` +
			`${pad(sg.getUTCHours())}:${pad(sg.getUTCMinutes())}:${pad(sg.getUTCSeconds())}`;
		const body = JSON.stringify({
			type: "error",
			error: {
				type: "1308",
				message: `Usage limit reached for 5 hour. Your limit will reset at ${stamp}`,
			},
		});
		return { resetUtcMs, body };
	}

	it("(a) returns the exact parsed resetUtcMs for a 1308 usage-limit body", async () => {
		const provider = new ZaiProvider();
		const { resetUtcMs, body } = makeFixture();
		const response = new Response(body, {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await provider.parseRateLimitFromBody(response);

		expect(result).toBe(resetUtcMs);
	});

	it("(b) leaves the passed response body unread (bodyUsed stays false)", async () => {
		const provider = new ZaiProvider();
		const { body } = makeFixture();
		const response = new Response(body, {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await provider.parseRateLimitFromBody(response);

		expect(response.bodyUsed).toBe(false);
		// And the body is still fully readable afterwards.
		await expect(response.clone().json()).resolves.toEqual(JSON.parse(body));
	});

	it("(c) returns undefined for a non-1308 error type", async () => {
		const provider = new ZaiProvider();
		const body = JSON.stringify({
			type: "error",
			error: { type: "some_other_error", message: "Something else happened" },
		});
		const response = new Response(body, {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await provider.parseRateLimitFromBody(response);

		expect(result).toBeUndefined();
	});

	it("(d) returns undefined without throwing for a malformed/non-JSON body", async () => {
		const provider = new ZaiProvider();
		const response = new Response("not json at all {{{", {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await provider.parseRateLimitFromBody(response);

		expect(result).toBeUndefined();
	});
});
