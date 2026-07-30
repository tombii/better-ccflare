/**
 * Pins the API-side `StreamTerminalState` union (@better-ccflare/types) to the
 * producer-side `AnthropicTerminalState` (../anthropic-terminal-recovery).
 *
 * The two cannot share one declaration: types is the base package, so it must
 * not depend on proxy. That leaves the set of states duplicated, and a state
 * added on one side only would silently produce values the other side claims
 * cannot exist.
 *
 * The two `Record` types below close that gap at COMPILE time — a key added to
 * either union makes the corresponding object literal incomplete and
 * `bun run typecheck` fails. The runtime assertions additionally pin the
 * exported `STREAM_TERMINAL_STATES` array to the same set, so the array cannot
 * drift away from the type it derives from.
 */
import { describe, expect, it } from "bun:test";
import type { StreamTerminalState } from "@better-ccflare/types";
import { STREAM_TERMINAL_STATES } from "@better-ccflare/types";
import type { AnthropicTerminalState } from "../anthropic-terminal-recovery";

// Every producer state must exist as an API state …
const PRODUCER_TO_API: Record<AnthropicTerminalState, StreamTerminalState> = {
	complete: "complete",
	recovered: "recovered",
	error: "error",
	truncated: "truncated",
	client_cancelled: "client_cancelled",
};

// … and every API state must exist as a producer state.
const API_TO_PRODUCER: Record<StreamTerminalState, AnthropicTerminalState> = {
	complete: "complete",
	recovered: "recovered",
	error: "error",
	truncated: "truncated",
	client_cancelled: "client_cancelled",
};

describe("stream terminal state — union parity with the producer", () => {
	it("covers exactly the same set on both sides", () => {
		expect(Object.keys(PRODUCER_TO_API).sort()).toEqual(
			Object.keys(API_TO_PRODUCER).sort(),
		);
	});

	it("keeps STREAM_TERMINAL_STATES in sync with the union", () => {
		expect([...STREAM_TERMINAL_STATES].sort()).toEqual(
			Object.keys(PRODUCER_TO_API).sort() as StreamTerminalState[],
		);
	});

	it("maps each state to itself (no silent renaming across the boundary)", () => {
		for (const state of STREAM_TERMINAL_STATES) {
			expect(PRODUCER_TO_API[state]).toBe(state);
			expect(API_TO_PRODUCER[state]).toBe(state);
		}
	});
});
