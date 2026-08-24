/**
 * Regression test for issue #382 — the in-place 529 retry previously sent a
 * pre-cloned `transformedRequestForRetry` Request whose tee branch was never
 * read, retaining its native off-heap buffer. The retry must instead rebuild
 * its Request from the buffered `retryBodyText`.
 *
 * Static/structural check, same convention as the issue #354 test
 * (proxy-operations-529-parselimit-clones.test.ts) — proxy-operations.ts is
 * not imported directly because its transitive dependency chain loads
 * @better-ccflare/database, which can fail to initialise in worktrees where
 * `bun install` has not run.
 *
 * Run: bun test packages/proxy/src/handlers/__tests__/proxy-operations-529-retry-clone-regression.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE_PATH = "packages/proxy/src/handlers/proxy-operations.ts";

function readSource(): string {
	return readFileSync(SOURCE_PATH, "utf-8");
}

describe("issue #382 — 529 in-place retry Request clone", () => {
	it("no longer contains the unread transformedRequestForRetry clone", () => {
		const source = readSource();
		expect(source).not.toMatch(/transformedRequestForRetry/);
	});

	it("rebuilds the retry Request from retryBodyText instead of a clone", () => {
		const source = readSource();
		expect(source).toMatch(
			/const retryRequest = new Request\(transformedRequest\.url, \{[\s\S]*?body: retryBodyText \|\| undefined,/,
		);
	});
});
