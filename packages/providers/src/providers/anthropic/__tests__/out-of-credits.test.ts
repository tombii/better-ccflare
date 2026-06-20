import { describe, expect, it } from "bun:test";
import { isAnthropicOutOfCredits, OUT_OF_CREDITS_REASON } from "../provider";

const OVERAGE_DISABLED_HEADER =
	"anthropic-ratelimit-unified-overage-disabled-reason";

function responseWithReason(reason?: string): Response {
	const headers = new Headers();
	if (reason !== undefined) {
		headers.set(OVERAGE_DISABLED_HEADER, reason);
	}
	return new Response(null, { status: 429, headers });
}

describe("isAnthropicOutOfCredits", () => {
	it("the exported reason constant is 'out_of_credits'", () => {
		expect(OUT_OF_CREDITS_REASON).toBe("out_of_credits");
	});

	it("returns true when the overage-disabled-reason header is out_of_credits", () => {
		expect(isAnthropicOutOfCredits(responseWithReason("out_of_credits"))).toBe(
			true,
		);
	});

	it("returns false when the header is absent", () => {
		expect(isAnthropicOutOfCredits(responseWithReason(undefined))).toBe(false);
	});

	it("returns false for a different overage-disabled-reason value", () => {
		expect(
			isAnthropicOutOfCredits(responseWithReason("organization_disabled")),
		).toBe(false);
	});

	it("returns false on an empty header value", () => {
		expect(isAnthropicOutOfCredits(responseWithReason(""))).toBe(false);
	});

	describe("comparison is exact and case-sensitive", () => {
		for (const reason of [
			"Out_Of_Credits",
			"OUT_OF_CREDITS",
			"out_of_Credits",
		]) {
			it(`"${reason}" (wrong case) => false`, () => {
				expect(isAnthropicOutOfCredits(responseWithReason(reason))).toBe(false);
			});
		}

		it("a value embedded in a larger string => false (exact match, no substring)", () => {
			expect(
				isAnthropicOutOfCredits(responseWithReason("out_of_credits_soon")),
			).toBe(false);
		});
	});
});
