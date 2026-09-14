/**
 * Regression test for issue #382 — the in-place 529 retry previously sent a
 * pre-cloned `transformedRequestForRetry` Request whose tee branch was never
 * read, retaining its native off-heap buffer. The retry must instead rebuild
 * its Request from a buffered body text.
 *
 * That buffered text now lives on the `outgoing` descriptor, the single source
 * of truth for the request in flight, so that a recovery which changed the
 * request (model fallback, cache-control strip, thinking-block filter) cannot
 * leave the replay holding a stale body.
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

	it("rebuilds the retry Request from the buffered body text instead of a clone", () => {
		const source = readSource();
		expect(source).toMatch(
			/const retryRequest = new Request\(outgoing\.request\.url, \{[\s\S]*?body: outgoing\.bodyText \|\| undefined,/,
		);
	});

	it("keeps the replayed request behind the single outgoing-descriptor setter", () => {
		const source = readSource();
		expect(source).toMatch(/const adoptOutgoingRequest = \(/);
		// Exactly one assignment each, the one inside the setter. A second
		// anywhere else is the drift this descriptor exists to prevent: it is
		// how `transformedRequest` and `retryBodyText` came apart, leaving the
		// in-place retry replaying a request the upstream had already rejected.
		expect(source.match(/outgoing\.request = /g) ?? []).toHaveLength(1);
		expect(source.match(/outgoing\.bodyText = /g) ?? []).toHaveLength(1);
		expect(source.match(/outgoing\.model = /g) ?? []).toHaveLength(1);
	});
});
