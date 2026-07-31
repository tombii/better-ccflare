/**
 * Pins the API-side state set (`@better-ccflare/types`) to the producer-side
 * set (`../anthropic-terminal-recovery`).
 *
 * The two cannot share one declaration: types is the base package and must not
 * depend on proxy. That leaves the set duplicated, and a state added on one
 * side only would produce values the other side claims cannot exist.
 *
 * This check is deliberately a RUNTIME comparison of two exported arrays, not
 * a type-level assertion. The root tsconfig excludes every `__tests__`
 * directory, so `tsc` never sees this file — a type-level trick here would
 * compile-check nothing and give false assurance. Both unions are derived from
 * their arrays via `(typeof ARRAY)[number]`, so comparing the arrays at
 * runtime does check the types.
 */
import { describe, expect, it } from "bun:test";
import {
	STREAM_TERMINAL_STATES,
	toStreamTerminalState,
} from "@better-ccflare/types/request";
import { ANTHROPIC_TERMINAL_STATES } from "../anthropic-terminal-recovery";

describe("stream terminal state — parity with the producer", () => {
	it("covers exactly the same set on both sides", () => {
		expect([...STREAM_TERMINAL_STATES].sort()).toEqual(
			[...ANTHROPIC_TERMINAL_STATES].sort(),
		);
	});

	it("accepts every state the producer can emit", () => {
		for (const state of ANTHROPIC_TERMINAL_STATES) {
			// A producer state the API cannot name would come back as "unknown".
			expect(toStreamTerminalState(state)).toBe(state);
		}
	});

	it('reports a state the API does not know as "unknown", not as absent', () => {
		expect(toStreamTerminalState("some_future_state")).toBe("unknown");
		expect(toStreamTerminalState("")).toBeUndefined();
		expect(toStreamTerminalState(null)).toBeUndefined();
		expect(toStreamTerminalState(undefined)).toBeUndefined();
		expect(toStreamTerminalState(42)).toBeUndefined();
	});
});
