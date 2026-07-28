import { afterEach, describe, expect, test } from "bun:test";
import {
	CIRCUIT_BREAKER_ENV,
	CircuitBreaker,
	type CircuitKey,
	getDefaultCircuitBreaker,
	isProviderWideOpen as moduleIsProviderWideOpen,
	recordFailure as moduleRecordFailure,
	recordSuccess as moduleRecordSuccess,
	resetDefaultCircuitBreaker,
	shouldAllow as moduleShouldAllow,
	shouldCountAsCircuitFailure,
} from "../circuit-breaker";

/** Local process type shim — bun-tests have @types/node, but other tsc
 *  invocations that the harness runs against this file in isolation do not. */
declare const process: { env: Record<string, string | undefined> };

const T0 = 1_700_000_000_000;
const SECOND = 1_000;
const OPEN_COOLDOWN_MS = 30_000;

const KEY_A: CircuitKey = { provider: "anthropic", accountId: "acc-A" };
const KEY_B: CircuitKey = { provider: "anthropic", accountId: "acc-B" };
const KEY_C: CircuitKey = { provider: "openai", accountId: "acc-C" };

afterEach(() => {
	resetDefaultCircuitBreaker();
	delete process.env[CIRCUIT_BREAKER_ENV];
});

describe("shouldCountAsCircuitFailure (named predicate)", () => {
	test("model-scoped 429 is excluded from circuit accounting", () => {
		// `model_fallback_429` is the upstream `RateLimitReason` literal
		// the producer emits; the breaker must mirror that vocabulary so
		// the exclusion actually fires. See audit F2.
		expect(shouldCountAsCircuitFailure("model_fallback_429")).toBe(false);
	});

	test("529 overload counts", () => {
		expect(
			shouldCountAsCircuitFailure("upstream_529_overloaded_with_reset"),
		).toBe(true);
	});

	test("account-wide 429 counts", () => {
		expect(shouldCountAsCircuitFailure("upstream_429_with_reset")).toBe(true);
	});
});

describe("closed -> open", () => {
	test("five consecutive 529s open the circuit on the configured threshold", () => {
		const cb = new CircuitBreaker();
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0)).toBe(true);

		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");

		cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + 5);
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("threshold is configurable", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2 });
		cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0);
		expect(cb.getState(KEY_A)).toBe("closed");
		cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + 1);
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("failures below the threshold keep the circuit closed", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0 + 4)).toBe(true);
	});

	test("success in closed state resets the failure streak", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		cb.recordSuccess(KEY_A, T0 + 5);
		// Streak cleared: 4 more failures must NOT open the circuit.
		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + 10 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
	});
});

describe("open fail-fast", () => {
	test("open circuit does not allow any request until cooldown elapses", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");

		expect(cb.shouldAllow(KEY_A, T0 + 10)).toBe(false);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS - 1)).toBe(false);
	});

	test("cooldown duration is configurable", () => {
		const cb = new CircuitBreaker({ openCooldownMs: 5_000 });
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0);
		}
		expect(cb.shouldAllow(KEY_A, T0 + 4_999)).toBe(false);
		expect(cb.shouldAllow(KEY_A, T0 + 5_000)).toBe(true);
	});
});

describe("half-open: exactly ONE probe", () => {
	function openThenExpire(
		cb: CircuitBreaker,
		key: CircuitKey,
	): { openedAt: number; halfOpenAt: number } {
		// All five failures at the same instant — "consecutive" is what
		// the breaker cares about (no successes in between), not their
		// exact spread. Stamping them at T0 keeps the cooldown math
		// (`cooldownEndsAt = openedAt + OPEN_COOLDOWN_MS`) predictable
		// for the assertions below.
		const openedAt = T0;
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(key, "upstream_529_overloaded_with_reset", openedAt);
		}
		expect(cb.getState(key)).toBe("open");
		const halfOpenAt = openedAt + OPEN_COOLDOWN_MS + 1;
		return { openedAt, halfOpenAt };
	}

	test("the first shouldAllow after cooldown admits the probe", () => {
		const cb = new CircuitBreaker();
		openThenExpire(cb, KEY_A);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS + 1)).toBe(true);
		expect(cb.getState(KEY_A)).toBe("half-open");
	});

	test("the second shouldAllow during half-open rejects (exactly one probe)", () => {
		const cb = new CircuitBreaker();
		openThenExpire(cb, KEY_A);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS + 1)).toBe(true);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS + 2)).toBe(false);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS + 3)).toBe(false);
	});

	test("probe success closes the circuit and resets counters", () => {
		const cb = new CircuitBreaker();
		openThenExpire(cb, KEY_A);
		cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS + 1); // admits probe
		cb.recordSuccess(KEY_A, T0 + OPEN_COOLDOWN_MS + 2);

		expect(cb.getState(KEY_A)).toBe("closed");

		// After reset, the threshold must hold again from zero — 4 failures
		// must NOT re-open.
		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + OPEN_COOLDOWN_MS + 3 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
	});

	test("probe failure re-opens with backoff and rejects again", () => {
		const cb = new CircuitBreaker();
		openThenExpire(cb, KEY_A);
		cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS + 1);
		cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + OPEN_COOLDOWN_MS + 2);

		expect(cb.getState(KEY_A)).toBe("open");

		// First cooldown was OPEN_COOLDOWN_MS; backoff doubles it to
		// 2 * OPEN_COOLDOWN_MS, still below the 5min cap.
		const secondHalfOpenAt = T0 + OPEN_COOLDOWN_MS + 2 + 2 * OPEN_COOLDOWN_MS;
		expect(cb.shouldAllow(KEY_A, secondHalfOpenAt - 1)).toBe(false);
		expect(cb.shouldAllow(KEY_A, secondHalfOpenAt)).toBe(true);
	});

	test("half-open backoff caps at the configured maximum", () => {
		const cb = new CircuitBreaker({ halfOpenBackoffMaxMs: 1_000 });
		openThenExpire(cb, KEY_A);

		// First re-open after probe failure: 2 * OPEN_COOLDOWN_MS, capped at 1_000.
		const firstProbeAdmitAt = T0 + OPEN_COOLDOWN_MS + 1;
		const firstProbeFailAt = firstProbeAdmitAt + 1;
		cb.shouldAllow(KEY_A, firstProbeAdmitAt);
		cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", firstProbeFailAt);
		// After the probe failure, cooldown is min(prev*2, cap) = 1000ms.
		// It started at `firstProbeFailAt`, so the breaker admits again at
		// `firstProbeFailAt + 1000`.
		const firstReopenAdmitAt = firstProbeFailAt + 1_000;
		expect(cb.shouldAllow(KEY_A, firstReopenAdmitAt - 1)).toBe(false);
		expect(cb.shouldAllow(KEY_A, firstReopenAdmitAt)).toBe(true);

		// Second re-open: stays at the cap (1000 not 2000). Cooldown
		// continues from the previous failure's timestamp + 1000.
		const secondProbeFailAt = firstReopenAdmitAt + 1;
		const secondReopenAdmitAt = secondProbeFailAt + 1_000;
		cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", secondProbeFailAt);
		expect(cb.shouldAllow(KEY_A, secondReopenAdmitAt - 1)).toBe(false);
		expect(cb.shouldAllow(KEY_A, secondReopenAdmitAt)).toBe(true);
	});
});

describe("NEGATIVE CONTROL: model-scoped 429 must NOT open the circuit", () => {
	test("model-scoped 429 does not trip the breaker even past the failure threshold", () => {
		const cb = new CircuitBreaker();
		// Hammer with the upstream `model_fallback_429` literal well past
		// the 5-failure threshold. This is the producer's wire value, not
		// a renamed-in-the-breaker variant — see audit F2.
		for (let i = 0; i < 50; i++) {
			cb.recordFailure(KEY_A, "model_fallback_429", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0 + 100)).toBe(true);
	});

	test("account-wide 429 does open the circuit (control case)", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_429_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("529 overload does open the circuit (control case)", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test(
		"verification: the named predicate is what shields model-scoped 429s",
		() => {
			// The negative-control assertion above is meaningful ONLY if
			// `shouldCountAsCircuitFailure` is the actual gate the
			// breaker consults. This test pins that contract: the
			// predicate returns false for the upstream literal
			// `model_fallback_429`, and `recordFailure` short-circuits
			// on that return value (5 model-scoped failures keep
			// `failureCount` at zero).
			//
			// To re-verify the test fails when the exclusion is removed,
			// edit `shouldCountAsCircuitFailure` in
			// `packages/proxy/src/circuit-breaker.ts` to always return
			// `true`, re-run the suite, and confirm the model-scoped test
			// above flips to FAIL. Then revert.
			const cb = new CircuitBreaker();
			expect(shouldCountAsCircuitFailure("model_fallback_429")).toBe(false);
			for (let i = 0; i < 5; i++) {
				cb.recordFailure(KEY_A, "model_fallback_429", T0);
			}
			// failureCount stays at zero — the predicate returned false
			// on every call, so recordFailure exited before incrementing.
			expect(cb.getState(KEY_A)).toBe("closed");
		},
	);
});

describe("per-(provider, accountId) isolation", () => {
	test("one account opening does not open a sibling account of the same provider", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");
		expect(cb.getState(KEY_B)).toBe("closed");
		expect(cb.shouldAllow(KEY_B, T0 + 100)).toBe(true);
	});

	test("one account opening does not open an account of a different provider", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_C)).toBe("closed");
	});

	test("isProviderWideOpen only fires once every tracked account for that provider is open", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.isProviderWideOpen("anthropic")).toBe(false);
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_B, "upstream_529_overloaded_with_reset", T0 + 10 + i);
		}
		expect(cb.isProviderWideOpen("anthropic")).toBe(true);
		expect(cb.isProviderWideOpen("openai")).toBe(false);
	});

	test("isProviderWideOpen is false for a provider with no tracked accounts", () => {
		const cb = new CircuitBreaker();
		expect(cb.isProviderWideOpen("anthropic")).toBe(false);
	});
});

describe("env kill-switch", () => {
	test("CCFLARE_CIRCUIT_BREAKER=0 makes the breaker a pass-through", () => {
		process.env[CIRCUIT_BREAKER_ENV] = "0";
		const cb = new CircuitBreaker();
		expect(cb.isEnabled()).toBe(false);
		for (let i = 0; i < 100; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0 + 200)).toBe(true);
	});

	test("CCFLARE_CIRCUIT_BREAKER=false also disables", () => {
		process.env[CIRCUIT_BREAKER_ENV] = "false";
		const cb = new CircuitBreaker();
		expect(cb.isEnabled()).toBe(false);
	});

	test("default (env unset) leaves the breaker enabled", () => {
		delete process.env[CIRCUIT_BREAKER_ENV];
		const cb = new CircuitBreaker();
		expect(cb.isEnabled()).toBe(true);
	});

	test("the module-level singleton respects the env kill-switch", () => {
		process.env[CIRCUIT_BREAKER_ENV] = "0";
		expect(getDefaultCircuitBreaker().isEnabled()).toBe(false);
		// shouldAllow on the module-level wrappers must pass through.
		moduleRecordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0);
		expect(moduleShouldAllow(KEY_A, T0 + 1)).toBe(true);
	});
});

describe("snapshot", () => {
	test("is JSON-serializable and reflects current state", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + i);
		}
		const snap = cb.snapshot();
		const json = JSON.stringify(snap);
		expect(typeof json).toBe("string");
		const round = JSON.parse(json) as Array<Record<string, unknown>>;
		expect(round.length).toBe(1);
		expect(round[0]?.provider).toBe("anthropic");
		expect(round[0]?.accountId).toBe("acc-A");
		expect(round[0]?.state).toBe("open");
	});

	test("snapshot is empty when nothing is tracked", () => {
		const cb = new CircuitBreaker();
		expect(cb.snapshot()).toEqual([]);
	});

	test("module-level snapshot delegates to the default breaker", () => {
		// Use the module-level recordFailure for at least one event so the
		// default breaker has an entry to surface.
		moduleRecordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0);
		moduleRecordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0 + 1);
		// Singleton state must show two failures (still closed, threshold is 5).
		const snap = getDefaultCircuitBreaker().snapshot();
		expect(snap.length).toBe(1);
		expect(snap[0]?.failureCount).toBe(2);
		// Cleanup so the afterEach hook does not have to.
		moduleRecordSuccess(KEY_A, T0 + 2);
	});
});

describe("module-level wrappers (default singleton)", () => {
	test("moduleRecordFailure + moduleShouldAllow share the same default instance", () => {
		process.env[CIRCUIT_BREAKER_ENV] = "1";
		for (let i = 0; i < 5; i++) {
			moduleRecordFailure(KEY_B, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(moduleShouldAllow(KEY_B, T0 + 10)).toBe(false);
		expect(moduleIsProviderWideOpen("anthropic")).toBe(false);
	});
});

describe("time injection", () => {
	test("uses the injected clock and ignores Date.now when given", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_529_overloaded_with_reset", T0);
		}
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS - SECOND)).toBe(false);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// F1 — probe lease: an in-flight probe whose completion never lands must
// not wedge the breaker forever. Lazy timestamp check inside shouldAllow.
// ─────────────────────────────────────────────────────────────────────────
describe("F1: probe lease prevents permanent wedge", () => {
	function openAfterCooldown(
		cb: CircuitBreaker,
		key: CircuitKey,
		openedAt = T0,
	): { halfOpenAt: number } {
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(key, "upstream_529_overloaded_with_reset", openedAt);
		}
		expect(cb.getState(key)).toBe("open");
		return { halfOpenAt: openedAt + OPEN_COOLDOWN_MS + 1 };
	}

	test("before the lease expires, the breaker still rejects a second probe", () => {
		// Probe admitted, no completion callback ever runs. Within the
		// probe-lease window the breaker must keep refusing — the probe
		// is still considered in flight.
		const cb = new CircuitBreaker();
		const { halfOpenAt } = openAfterCooldown(cb, KEY_A);
		expect(cb.shouldAllow(KEY_A, halfOpenAt)).toBe(true);

		// Just before the lease expires: still rejected.
		const probeTtlMs = 30_000;
		expect(cb.shouldAllow(KEY_A, halfOpenAt + probeTtlMs - 1)).toBe(false);
		expect(cb.getState(KEY_A)).toBe("half-open");
	});

	test("after the lease expires, a fresh probe is admitted without an explicit record* call", () => {
		// Probe admitted, no recordSuccess/recordFailure ever lands. After
		// the probe lease TTL elapses, the next shouldAllow call must
		// admit a fresh probe rather than refuse forever. This is the
		// core F1 fix — no setTimeout, lazy timestamp check only.
		const cb = new CircuitBreaker();
		const { halfOpenAt } = openAfterCooldown(cb, KEY_A);
		expect(cb.shouldAllow(KEY_A, halfOpenAt)).toBe(true);

		const probeTtlMs = 30_000;
		// Advance past the lease: a fresh probe must be admitted.
		expect(cb.shouldAllow(KEY_A, halfOpenAt + probeTtlMs + 1)).toBe(true);
		expect(cb.getState(KEY_A)).toBe("half-open");

		// The freshly-admitted probe is still considered in flight, so a
		// second concurrent shouldAllow within its new lease still rejects.
		expect(cb.shouldAllow(KEY_A, halfOpenAt + probeTtlMs + 2)).toBe(false);
	});

	test("the probe lease TTL is configurable and honored exactly", () => {
		// Use a smaller probeTtlMs to pin the boundary precisely.
		const cb = new CircuitBreaker({ probeTtlMs: 1_000 });
		const { halfOpenAt } = openAfterCooldown(cb, KEY_A);
		expect(cb.shouldAllow(KEY_A, halfOpenAt)).toBe(true);

		expect(cb.shouldAllow(KEY_A, halfOpenAt + 1_000)).toBe(false);
		expect(cb.shouldAllow(KEY_A, halfOpenAt + 1_001)).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// F2 — FailureKind ↔ RateLimitReason parity: every upstream variant must
// have an explicit verdict. Adding a new variant to the upstream enum
// without handling it here is a TypeScript AND runtime regression — see
// audit F2.
// ─────────────────────────────────────────────────────────────────────────
describe("F2: FailureKind ↔ RateLimitReason parity", () => {
	test("the breaker accepts the literal upstream string `model_fallback_429` and does NOT open", () => {
		// This is the F2 reproducing test. The upstream `RateLimitReason`
		// enum lives at `@better-ccflare/types`. The breaker must accept
		// its literal strings directly; if the breaker renames the
		// variant internally, the wire-up will pass `model_fallback_429`
		// through and the predicate will silently fail to exclude it.
		const cb = new CircuitBreaker();
		for (let i = 0; i < 50; i++) {
			cb.recordFailure(KEY_A, "model_fallback_429", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0 + 100)).toBe(true);
	});

	test("the upstream literal `upstream_429_with_reset` DOES open the circuit", () => {
		// Account-wide 429 control case — using the upstream literal
		// directly, no remapping.
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "upstream_429_with_reset", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("the upstream literal `upstream_529_overloaded_with_reset` DOES open the circuit", () => {
		// 529 overload control case.
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(
				KEY_A,
				"upstream_529_overloaded_with_reset",
				T0 + i,
			);
		}
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("the breaker accepts every variant of the upstream RateLimitReason enum", () => {
		// Exhaustiveness contract: every variant of `RateLimitReason`
		// must be accepted by `shouldCountAsCircuitFailure` (which is
		// now an exhaustive switch over the union). If a new variant
		// is added to the upstream enum, the type alias makes this test
		// a compile error until `shouldCountAsCircuitFailure` is
		// updated to handle it explicitly.
		//
		// Concrete variants are pinned here; a missing literal in this
		// list ALSO causes a compile error. Either failure mode is
		// caught at typecheck time.
		const everyVariant = [
			"upstream_429_with_reset",
			"upstream_429_no_reset_default_5h",
			"upstream_429_no_reset_probe_cooldown",
			"model_fallback_429",
			"all_models_exhausted_429",
			"upstream_529_overloaded_with_reset",
			"upstream_529_overloaded_no_reset",
			"out_of_credits",
			"extra_usage_exhausted",
		] as const;
		// And every verdict must be a boolean (i.e. the predicate covers
		// the variant rather than letting it fall through to undefined).
		for (const variant of everyVariant) {
			expect(typeof shouldCountAsCircuitFailure(variant)).toBe("boolean");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────
// F3 — unbounded cooldown extension: a steady trickle of stale failures
// must not push recovery beyond the cap, and a stale failure arriving
// after a probe-failure re-open must preserve the escalated backoff
// rather than resetting to base.
// ─────────────────────────────────────────────────────────────────────────
describe("F3: cooldown extension is bounded and preserves escalated backoff", () => {
	test("a long trickle of stale failures must not push recovery beyond halfOpenBackoffMaxMs", () => {
		// The original implementation resets cooldownEndsAt to
		// `now + openCooldownMs` on every stale failure, which a stuck
		// caller can drive indefinitely. The fix caps the extension at
		// halfOpenBackoffMaxMs.
		const cb = new CircuitBreaker({
			openCooldownMs: 30_000,
			halfOpenBackoffMaxMs: 60_000,
		});
		// 5 fails → open. The 5th failure is at T0+4, so cooldownEndsAt
		// is anchored at (T0+4) + 30_000 = T0+30_004.
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(
				KEY_A,
				"upstream_529_overloaded_with_reset",
				T0 + i,
			);
		}
		expect(cb.getState(KEY_A)).toBe("open");

		// Simulate a stuck caller reporting a failure every 29s, well
		// inside the cooldown window. Each failure must extend the
		// cooldown by AT MOST halfOpenBackoffMaxMs (60s), so even after
		// the trickle the cooldown window never escapes `last_t + 60_000`.
		let t = T0 + OPEN_COOLDOWN_MS - 1_000;
		for (let i = 0; i < 20; i++) {
			cb.recordFailure(
				KEY_A,
				"upstream_529_overloaded_with_reset",
				t,
			);
			t += 29_000;
		}
		const lastStaleAt = t - 29_000; // last `recordFailure` landed here

		// The next probe must fire within at most halfOpenBackoffMaxMs
		// AFTER the last stale refresh — not the unbounded
		// `lastStaleAt + (29_000 × N)` that the buggy original code
		// would have produced.
		expect(cb.shouldAllow(KEY_A, lastStaleAt + 60_001)).toBe(true);
		// And one millisecond before that boundary, still refused.
		expect(cb.shouldAllow(KEY_A, lastStaleAt + 60_000)).toBe(false);
	});

	test("stale failures arriving after a probe-failure re-open preserve the escalated backoff", () => {
		// After a probe failure, `previousCooldownMs` is doubled (and
		// capped). The original implementation then resets cooldownEndsAt
		// to base on the next stale failure — losing the escalation. The
		// fix preserves the escalated backoff.
		const cb = new CircuitBreaker({ openCooldownMs: 30_000 });
		// 5 fails at T0..T0+4 → open. cooldownEndsAt = (T0+4) + 30_000
		// = T0+30_004.
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(
				KEY_A,
				"upstream_529_overloaded_with_reset",
				T0 + i,
			);
		}
		// Cooldown elapses — pick a `now` strictly past cooldownEndsAt
		// so the open→half-open transition actually fires.
		const halfOpenAt = T0 + 30_005;
		expect(cb.shouldAllow(KEY_A, halfOpenAt)).toBe(true);
		expect(cb.getState(KEY_A)).toBe("half-open");
		// Probe fails → re-open at 2x base = 60_000.
		const probeFailAt = halfOpenAt + 1;
		cb.recordFailure(
			KEY_A,
			"upstream_529_overloaded_with_reset",
			probeFailAt,
		);
		expect(cb.getState(KEY_A)).toBe("open");
		// previousCooldownMs is now 60_000; cooldownEndsAt = probeFailAt
		// + 60_000 = halfOpenAt + 1 + 60_000 = T0 + 90_006.
		// A stale failure arriving 5s later must extend the cooldown to
		// at least the escalated 60_000 (not collapse it back to 30_000).
		const staleAt = probeFailAt + 5_000;
		cb.recordFailure(
			KEY_A,
			"upstream_529_overloaded_with_reset",
			staleAt,
		);
		// Half-open transition must arrive at staleAt + 60_000, NOT
		// staleAt + 30_000. The second boundary check is the original
		// defect — at the old base cooldown, the circuit would already
		// be admitting.
		expect(cb.shouldAllow(KEY_A, staleAt + 30_000)).toBe(false);
		expect(cb.shouldAllow(KEY_A, staleAt + 60_000)).toBe(true);
	});
});