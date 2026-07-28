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
		expect(shouldCountAsCircuitFailure("rate_limit_429_model_scoped")).toBe(
			false,
		);
	});

	test("529 overload counts", () => {
		expect(shouldCountAsCircuitFailure("overload_529")).toBe(true);
	});

	test("account-wide 429 counts", () => {
		expect(shouldCountAsCircuitFailure("rate_limit_429_global")).toBe(true);
	});
});

describe("closed -> open", () => {
	test("five consecutive 529s open the circuit on the configured threshold", () => {
		const cb = new CircuitBreaker();
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0)).toBe(true);

		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");

		cb.recordFailure(KEY_A, "overload_529", T0 + 5);
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("threshold is configurable", () => {
		const cb = new CircuitBreaker({ failureThreshold: 2 });
		cb.recordFailure(KEY_A, "overload_529", T0);
		expect(cb.getState(KEY_A)).toBe("closed");
		cb.recordFailure(KEY_A, "overload_529", T0 + 1);
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("failures below the threshold keep the circuit closed", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0 + 4)).toBe(true);
	});

	test("success in closed state resets the failure streak", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		cb.recordSuccess(KEY_A, T0 + 5);
		// Streak cleared: 4 more failures must NOT open the circuit.
		for (let i = 0; i < 4; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + 10 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
	});
});

describe("open fail-fast", () => {
	test("open circuit does not allow any request until cooldown elapses", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");

		expect(cb.shouldAllow(KEY_A, T0 + 10)).toBe(false);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS - 1)).toBe(false);
	});

	test("cooldown duration is configurable", () => {
		const cb = new CircuitBreaker({ openCooldownMs: 5_000 });
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0);
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
			cb.recordFailure(key, "overload_529", openedAt);
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
			cb.recordFailure(KEY_A, "overload_529", T0 + OPEN_COOLDOWN_MS + 3 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
	});

	test("probe failure re-opens with backoff and rejects again", () => {
		const cb = new CircuitBreaker();
		openThenExpire(cb, KEY_A);
		cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS + 1);
		cb.recordFailure(KEY_A, "overload_529", T0 + OPEN_COOLDOWN_MS + 2);

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
		cb.recordFailure(KEY_A, "overload_529", firstProbeFailAt);
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
		cb.recordFailure(KEY_A, "overload_529", secondProbeFailAt);
		expect(cb.shouldAllow(KEY_A, secondReopenAdmitAt - 1)).toBe(false);
		expect(cb.shouldAllow(KEY_A, secondReopenAdmitAt)).toBe(true);
	});
});

describe("NEGATIVE CONTROL: model-scoped 429 must NOT open the circuit", () => {
	test("model-scoped 429 does not trip the breaker even past the failure threshold", () => {
		const cb = new CircuitBreaker();
		// Hammer with model-scoped 429s well past the 5-failure threshold.
		for (let i = 0; i < 50; i++) {
			cb.recordFailure(KEY_A, "rate_limit_429_model_scoped", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("closed");
		expect(cb.shouldAllow(KEY_A, T0 + 100)).toBe(true);
	});

	test("account-wide 429 does open the circuit (control case)", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "rate_limit_429_global", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test("529 overload does open the circuit (control case)", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");
	});

	test(
		"verification: the named predicate is what shields model-scoped 429s",
		() => {
			// The negative-control assertion above is meaningful ONLY if
			// `shouldCountAsCircuitFailure` is the actual gate the
			// breaker consults. This test pins that contract: the
			// predicate returns false for `rate_limit_429_model_scoped`,
			// and `recordFailure` short-circuits on that return value
			// (5 model-scoped failures keep `failureCount` at zero).
			//
			// To re-verify the test fails when the exclusion is removed,
			// edit `shouldCountAsCircuitFailure` in
			// `packages/proxy/src/circuit-breaker.ts` to always return
			// `true`, re-run the suite, and confirm the model-scoped test
			// above flips to FAIL. Then revert.
			const cb = new CircuitBreaker();
			expect(shouldCountAsCircuitFailure("rate_limit_429_model_scoped")).toBe(
				false,
			);
			for (let i = 0; i < 5; i++) {
				cb.recordFailure(KEY_A, "rate_limit_429_model_scoped", T0);
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
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.getState(KEY_A)).toBe("open");
		expect(cb.getState(KEY_B)).toBe("closed");
		expect(cb.shouldAllow(KEY_B, T0 + 100)).toBe(true);
	});

	test("one account opening does not open an account of a different provider", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.getState(KEY_C)).toBe("closed");
	});

	test("isProviderWideOpen only fires once every tracked account for that provider is open", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
		}
		expect(cb.isProviderWideOpen("anthropic")).toBe(false);
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_B, "overload_529", T0 + 10 + i);
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
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
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
		moduleRecordFailure(KEY_A, "overload_529", T0);
		expect(moduleShouldAllow(KEY_A, T0 + 1)).toBe(true);
	});
});

describe("snapshot", () => {
	test("is JSON-serializable and reflects current state", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0 + i);
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
		moduleRecordFailure(KEY_A, "overload_529", T0);
		moduleRecordFailure(KEY_A, "overload_529", T0 + 1);
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
			moduleRecordFailure(KEY_B, "overload_529", T0 + i);
		}
		expect(moduleShouldAllow(KEY_B, T0 + 10)).toBe(false);
		expect(moduleIsProviderWideOpen("anthropic")).toBe(false);
	});
});

describe("time injection", () => {
	test("uses the injected clock and ignores Date.now when given", () => {
		const cb = new CircuitBreaker();
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(KEY_A, "overload_529", T0);
		}
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS - SECOND)).toBe(false);
		expect(cb.shouldAllow(KEY_A, T0 + OPEN_COOLDOWN_MS)).toBe(true);
	});
});