/**
 * Regression test for issue #354 — three orphaned Response.clone() sites on
 * the 529 overload path in proxy-operations.ts:
 *
 *   1 & 2. The two `provider.parseRateLimit(response.clone())` calls (initial
 *      529 check, and the in-place retry check). `parseRateLimit` is
 *      synchronous and reads only headers/status — it can never consume a
 *      body, so those clones were orphaned by construction. Both must now
 *      pass the response directly, with no clone.
 *
 *   3. The `responseForRateLimitCheck` clone taken for the terminal-529 path
 *      (returnRateLimitedResponseOnExhaustion). Unlike the two above, this
 *      clone's reader (processProxyResponse) can legitimately consume a
 *      body, so the clone itself is still needed — but it must be disposed
 *      of via `cancelDiscardedResponseBody` (drainBody under the hood) right
 *      after, not left to leak. `body.cancel()` is a proven no-op on Bun
 *      (see discard-body-cancel.ts / bench/drain-strategy-harness.ts), so
 *      this must NOT be the disposal mechanism.
 *
 * This is a static/structural check, consistent with the repo's existing
 * issue #273 regression test (bun-leak-273-regression.test.ts Group B) —
 * proxy-operations.ts is not imported directly here because its transitive
 * dependency chain loads @better-ccflare/database, which can fail to
 * initialise in worktrees where `bun install` has not run.
 *
 * Run: bun test packages/proxy/src/handlers/__tests__/proxy-operations-529-parselimit-clones.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE_PATH = "packages/proxy/src/handlers/proxy-operations.ts";

function readSource(): string {
	return readFileSync(SOURCE_PATH, "utf-8");
}

describe("issue #354 — 529 path parseRateLimit clones", () => {
	it("the initial 529 parseRateLimit call passes the response directly, no clone", () => {
		const source = readSource();
		expect(source).toMatch(
			/const rlInfo = provider\.parseRateLimit\(response\);/,
		);
		expect(source).not.toMatch(
			/const rlInfo = provider\.parseRateLimit\(response\.clone\(\)\);/,
		);
	});

	it("the in-place retry parseRateLimit call passes the retry response directly, no clone", () => {
		const source = readSource();
		expect(source).toMatch(
			/const retryRlInfo = provider\.parseRateLimit\(retryResponse\);/,
		);
		expect(source).not.toMatch(
			/const retryRlInfo = provider\.parseRateLimit\(retryResponse\.clone\(\)\);/,
		);
	});
});

describe("issue #354 — terminal-529 responseForRateLimitCheck clone disposal", () => {
	it("the clone is disposed via cancelDiscardedResponseBody, not body.cancel()", () => {
		const source = readSource();
		expect(source).toMatch(
			/cancelDiscardedResponseBody\(responseForRateLimitCheck\);/,
		);
		// Must not regress to the no-op disposal mechanism.
		expect(source).not.toMatch(/responseForRateLimitCheck\.body\?\.cancel\(\)/);
	});

	it("the disposal call sits after processProxyResponse resolves, gated on needsRateLimitCheckClone", () => {
		const source = readSource();
		const processIdx = source.indexOf(
			"const isRateLimited = await processProxyResponse(",
		);
		const disposeIdx = source.indexOf(
			"cancelDiscardedResponseBody(responseForRateLimitCheck);",
		);
		expect(processIdx).toBeGreaterThan(-1);
		expect(disposeIdx).toBeGreaterThan(processIdx);

		// The gate variable gates the clone itself; verify it also guards
		// the dispose call rather than the dispose running unconditionally
		// against a response that was never cloned.
		const gateForDispose = source.slice(disposeIdx - 120, disposeIdx);
		expect(gateForDispose).toMatch(/if \(needsRateLimitCheckClone\)/);
	});
});
