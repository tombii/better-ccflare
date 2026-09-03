/**
 * Regression test: the in-place 529 retry must not be gated on
 * `rlInfo.isRateLimited`.
 *
 * BaseProvider.parseRateLimit only reports isRateLimited from the unified
 * rate-limit headers or a 429 status. A provider that sends neither — zai is
 * one — therefore always answers `false` on a 529, so the reset-less-529
 * branch was unreachable for exactly the overload case it exists for, and the
 * inner loop broke out after a single attempt regardless of the configured
 * budget. Both sites are already inside `response.status === 529`, so the
 * reset hint alone decides in-place retry vs. cooldown.
 *
 * Static/structural check, same convention as the issue #354 and #382 tests
 * in this directory — proxy-operations.ts is not imported directly because its
 * transitive dependency chain loads @better-ccflare/database, which can fail to
 * initialise in worktrees where `bun install` has not run.
 *
 * Run: bun test packages/proxy/src/handlers/__tests__/proxy-operations-529-retry-gate.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE_PATH = "packages/proxy/src/handlers/proxy-operations.ts";

function readSource(): string {
	return readFileSync(SOURCE_PATH, "utf-8");
}

describe("529 in-place retry gating", () => {
	it("enters the retry branch on reset-less 529 without consulting isRateLimited", () => {
		const source = readSource();
		expect(source).toMatch(/if \(!rlInfo\.resetTime\) \{/);
		expect(source).not.toMatch(/rlInfo\.isRateLimited && !rlInfo\.resetTime/);
	});

	it("stops retrying only on a reset hint, not on isRateLimited", () => {
		const source = readSource();
		expect(source).toMatch(/if \(retryRlInfo\.resetTime\) \{/);
		expect(source).not.toMatch(
			/!retryRlInfo\.isRateLimited \|\| retryRlInfo\.resetTime/,
		);
	});
});
