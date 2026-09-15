/**
 * Pins the contract between LOCAL_REFUSAL_ERROR_TYPES and the code that
 * actually produces those bodies.
 *
 * The auto-refresh scheduler exempts a failed probe from failure accounting
 * only when the response is better-ccflare's OWN refusal, which it recognises
 * by the `error.type` in the body. That set is a hand-maintained mirror of
 * three producers, and nothing but this test stops the two drifting: rename a
 * PoolExhaustionKind, or change what createPoolExhaustedResponse puts in
 * `error.type`, and the scheduler silently starts counting our own refusals as
 * endpoint failures again — which is the 2026-09-15 probe loop.
 *
 * Imports come straight from the source files rather than the handlers barrel,
 * which transitively pulls in heavy provider modules just to type resolve.
 */
import { describe, expect, it } from "bun:test";
import {
	createPoolExhaustedResponse,
	type PoolExhaustionKind,
} from "../handlers/proxy-operations";
import { LOCAL_REFUSAL_ERROR_TYPES } from "../handlers/proxy-types";

type RefusalBody = { type?: unknown; error?: { type?: unknown } };

const KINDS: readonly PoolExhaustionKind[] = ["pool_exhausted", "circuit_open"];

describe("LOCAL_REFUSAL_ERROR_TYPES — pinned to its producers", () => {
	for (const kind of KINDS) {
		it(`recognises the body createPoolExhaustedResponse builds for ${kind}`, async () => {
			const response = createPoolExhaustedResponse([], undefined, kind);
			const body = (await response.json()) as RefusalBody;

			expect(response.status).toBe(503);
			expect(body.type).toBe("error");
			expect(typeof body.error?.type).toBe("string");
			expect(LOCAL_REFUSAL_ERROR_TYPES).toContain(body.error?.type as string);
		});
	}

	it("still covers the service_unavailable_error producers", () => {
		// proxy.ts's two refusal helpers and the server's catch-all for
		// ERROR_MESSAGES.ALL_ACCOUNTS_FAILED all emit this type; neither is
		// exported, so the string is pinned here and a comment at each producer
		// points back at the constant.
		expect(LOCAL_REFUSAL_ERROR_TYPES).toContain("service_unavailable_error");
	});

	it("names nothing beyond the three local producers", () => {
		// A stray entry would exempt an upstream error type from the failure
		// accounting, which is the failure mode this gate exists to prevent.
		expect([...LOCAL_REFUSAL_ERROR_TYPES].sort()).toEqual([
			"circuit_open",
			"pool_exhausted",
			"service_unavailable_error",
		]);
	});
});
